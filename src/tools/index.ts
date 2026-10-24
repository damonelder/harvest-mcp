/**
 * MCP Tool Registration
 *
 * Registers all Harvest API tools with the MCP server
 */

import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import type { Session, SessionStore } from '../session/types.js';
import type { Config } from '../config.js';
import { HarvestClient, HarvestApiError } from '../harvest/client.js';
import { HarvestOAuth, HarvestOAuthError } from '../auth/oauth.js';
import { RatesService } from '../rates/index.js';
import { EntityResolver } from '../entities/index.js';
import { ProfitabilityCalculator, UtilizationCalculator, TimeAggregationCalculator, BudgetPerformanceCalculator } from '../compute/index.js';
import { getSchema } from '../schema/index.js';

/** Strict calendar date accepted by Harvest for spent/issue/due dates and ranges. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/**
 * Helper to get an authenticated Harvest client for the session
 */
async function getHarvestClient(
  session: Session,
  sessionStore: SessionStore,
  config: Config
): Promise<HarvestClient | null> {
  // Check if session has valid tokens
  if (!session.harvestAccessToken) {
    return null;
  }

  // Check if token needs refresh
  const bufferMs = 5 * 60 * 1000; // 5 minutes
  const isFresh = (sess: Session) =>
    !!sess.harvestAccessToken && Date.now() + bufferMs < new Date(sess.tokenExpiresAt).getTime();

  if (!isFresh(session)) {
    // Another request (possibly in another isolate) may already have refreshed.
    const latest = await sessionStore.get(session.id);
    if (latest && isFresh(latest)) {
      Object.assign(session, latest);
    } else {
      try {
        const oauth = new HarvestOAuth(config.harvest);
        const newTokens = await oauth.refreshToken((latest ?? session).harvestRefreshToken);

        session.harvestAccessToken = newTokens.access_token;
        session.harvestRefreshToken = newTokens.refresh_token;
        session.tokenExpiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

        await sessionStore.set(session.id, session);
      } catch (error) {
        if (error instanceof HarvestOAuthError && error.isInvalidGrant) {
          // A concurrent request may have rotated the refresh token first;
          // if so, adopt its result instead of logging the user out.
          const after = await sessionStore.get(session.id);
          if (after && isFresh(after)) {
            Object.assign(session, after);
            return new HarvestClient(session.harvestAccessToken, session.harvestAccountId, { userAgent: 'HarvestMCP/0.2.0' });
          }
          // Harvest revoked or expired the grant: force re-authorization.
          console.error('Harvest token refresh rejected; clearing session tokens');
          session.harvestAccessToken = '';
          await sessionStore.set(session.id, session);
          return null;
        }
        // Transient failure (network, Harvest 5xx): keep the session intact.
        throw new Error('Could not refresh the Harvest token right now (temporary error). Please try again shortly.');
      }
    }
  }

  return new HarvestClient(
    session.harvestAccessToken,
    session.harvestAccountId,
    { userAgent: 'HarvestMCP/0.1.0' }
  );
}

/**
 * Message returned when the Harvest authorization has lapsed. Re-authorization
 * happens through the MCP client's connector flow (the next request receives a
 * 401 and the client restarts OAuth), not through a link in tool output.
 */
const AUTH_REQUIRED_MESSAGE =
  'Harvest authorization has expired. Reconnect the Harvest connector in Claude ' +
  '(Settings > Connectors) and try again.';

/**
 * MCP tool annotations by naming convention. Clients use these to decide how
 * prominently to ask for approval; deletes are flagged destructive.
 */
export function annotationsFor(name: string): ToolAnnotations {
  if (name === 'harvest_init' || name === 'harvest_get_schema') {
    return { readOnlyHint: true, openWorldHint: false };
  }
  if (/^harvest_delete_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
  }
  if (/^harvest_(create|add|assign|restart)_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  }
  if (name === 'harvest_update_invoice') {
    // Can append line items, so repeating it is not safe.
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  }
  if (/^harvest_(update|stop)_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  }
  return { readOnlyHint: true, openWorldHint: true };
}

/** Wrap an API failure as a tool error result (keeps Harvest's error body). */
function apiErrorResult(error: unknown) {
  if (error instanceof HarvestApiError) {
    const detail = error.errorBody ? `\n${error.errorBody}` : '';
    return {
      content: [{ type: 'text' as const, text: `Harvest API error: ${error.message}${detail}` }],
      isError: true,
    };
  }
  if (error instanceof Error) {
    return { content: [{ type: 'text' as const, text: error.message }], isError: true };
  }
  throw error;
}

function authRequiredResult() {
  return { content: [{ type: 'text' as const, text: AUTH_REQUIRED_MESSAGE }], isError: true };
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** Drop undefined values so PATCH bodies only carry fields the caller set. */
function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function registerTools(
  server: McpServer,
  session: Session,
  sessionStore: SessionStore,
  config: Config
): void {
  // ============================================
  // SESSION BOOTSTRAP
  // ============================================

  // Every tool is registered through this wrapper so it carries annotations
  // and appears in harvest_init's list automatically.
  const REGISTERED_TOOLS: string[] = [];
  const rawTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  function tool<Args extends ZodRawShapeCompat>(
    name: string,
    description: string,
    schema: Args,
    cb: ToolCallback<Args>
  ): void {
    REGISTERED_TOOLS.push(name);
    rawTool(name, description, schema, annotationsFor(name), cb);
  }

  // Registered first so it is always present in the active tool context.
  // claude.ai's tool_search only surfaces subsets of a large manifest, so
  // calling harvest_init at the start of a billing session pulls the full
  // list of Harvest tool names into context.

  tool(
    'harvest_init',
    'Initialize a Harvest billing session by loading the full list of available Harvest tools into context. Call this first when starting work so every harvest_* tool is discoverable, even when tool search only surfaces a subset.',
    {},
    async () => {
      const summary = {
        tool_count: REGISTERED_TOOLS.length,
        tools: REGISTERED_TOOLS,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // ============================================
  // ACCOUNT & COMPANY TOOLS
  // ============================================

  tool(
    'harvest_get_company',
    'Get information about the authenticated Harvest company/account',
    {},
    async () => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const company = await client.getCompany();
        return {
          content: [{ type: 'text', text: JSON.stringify(company, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_get_current_user',
    'Get information about the currently authenticated Harvest user',
    {},
    async () => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const user = await client.getCurrentUser();
        return {
          content: [{ type: 'text', text: JSON.stringify(user, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_list_users',
    'List all users in the Harvest account with optional filters',
    {
      is_active: z.boolean().optional().describe('Filter by active status'),
      updated_since: z.string().optional().describe('Only return users updated since this date (ISO 8601)'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page (1-2000)'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const { auto_paginate, ...filterParams } = params;
        
        if (auto_paginate) {
          const result = await client.autoPaginate(
            (p) => client.listUsers({ ...filterParams, ...p }),
            filterParams,
            { maxPages: 10, perPage: params.per_page || 100 }
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        const users = await client.listUsers(filterParams);
        return {
          content: [{ type: 'text', text: JSON.stringify(users, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // TIME ENTRY TOOLS
  // ============================================

  tool(
    'harvest_list_time_entries',
    'List time entries with optional filters (user, client, project, date range, etc.)',
    {
      user_id: z.number().optional().describe('Filter by user ID'),
      client_id: z.number().optional().describe('Filter by client ID'),
      project_id: z.number().optional().describe('Filter by project ID'),
      is_billed: z.boolean().optional().describe('Filter by billed status'),
      is_running: z.boolean().optional().describe('Filter by running timer'),
      from: isoDate.optional().describe('Start date (YYYY-MM-DD)'),
      to: isoDate.optional().describe('End date (YYYY-MM-DD)'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page (1-2000)'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const { auto_paginate, ...filterParams } = params;
        
        if (auto_paginate) {
          const result = await client.autoPaginate(
            (p) => client.listTimeEntries({ ...filterParams, ...p }),
            filterParams,
            { maxPages: 10, perPage: params.per_page || 100 }
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        const timeEntries = await client.listTimeEntries(filterParams);
        return {
          content: [{ type: 'text', text: JSON.stringify(timeEntries, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_get_time_entry',
    'Get a specific time entry by ID',
    {
      id: z.number().describe('Time entry ID'),
    },
    async ({ id }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const timeEntry = await client.getTimeEntry(id);
        return {
          content: [{ type: 'text', text: JSON.stringify(timeEntry, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_create_time_entry',
    'Create a new time entry',
    {
      project_id: z.number().describe('Project ID'),
      task_id: z.number().describe('Task ID'),
      spent_date: isoDate.describe('Date (YYYY-MM-DD)'),
      hours: z.number().optional().describe('Hours to log (omit to start timer)'),
      notes: z.string().optional().describe('Notes/description'),
      started_time: z.string().optional().describe('Start time (HH:MM, 12h format like "9:00am")'),
      ended_time: z.string().optional().describe('End time (HH:MM, 12h format like "5:00pm")'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const timeEntry = await client.createTimeEntry(params);
        return {
          content: [{ type: 'text', text: JSON.stringify(timeEntry, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_stop_timer',
    'Stop a running timer on a time entry',
    {
      id: z.number().describe('Time entry ID'),
    },
    async ({ id }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const timeEntry = await client.stopTimeEntry(id);
        return {
          content: [{ type: 'text', text: JSON.stringify(timeEntry, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_delete_time_entry',
    'Delete a time entry. Use this to remove erroneous or unwanted time entries.',
    {
      id: z.number().describe('Time entry ID to delete'),
    },
    async ({ id }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        await client.deleteTimeEntry(id);
        return {
          content: [{ type: 'text', text: `Time entry ${id} has been deleted successfully.` }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_update_time_entry',
    'Update an existing time entry. Provide the time entry ID plus any fields to change.',
    {
      id: z.number().describe('Time entry ID to update'),
      spent_date: isoDate.optional().describe('Date (YYYY-MM-DD)'),
      hours: z.number().optional().describe('Hours logged'),
      notes: z.string().optional().describe('Notes/description'),
      project_id: z.number().optional().describe('Project ID'),
      task_id: z.number().optional().describe('Task ID'),
    },
    async ({ id, ...updates }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const timeEntry = await client.updateTimeEntry(id, updates);
        return {
          content: [{ type: 'text', text: JSON.stringify(timeEntry, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // CLIENT TOOLS
  // ============================================

  tool(
    'harvest_list_clients',
    'List all clients. Note: Client contacts (people) are available via harvest_list_contacts tool.',
    {
      is_active: z.boolean().optional().describe('Filter by active status'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const { auto_paginate, ...filterParams } = params;
        
        if (auto_paginate) {
          const result = await client.autoPaginate(
            (p) => client.listClients({ ...filterParams, ...p }),
            filterParams,
            { maxPages: 10, perPage: params.per_page || 100 }
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        const clients = await client.listClients(filterParams);
        return {
          content: [{ type: 'text', text: JSON.stringify(clients, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // CLIENT CONTACT TOOLS
  // ============================================

  tool(
    'harvest_list_contacts',
    'List client contacts (people associated with clients). Filter by client_id to get contacts for a specific client. Returns contact details including name, title, email, and phone numbers.',
    {
      client_id: z.number().optional().describe('Filter contacts by client ID (highly recommended)'),
      updated_since: z.string().optional().describe('Only return contacts updated since this date (ISO 8601)'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page (1-2000)'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const { auto_paginate, ...filterParams } = params;

        if (auto_paginate) {
          const result = await client.autoPaginate(
            (p) => client.listContacts({ ...filterParams, ...p }),
            filterParams,
            { maxPages: 10, perPage: params.per_page || 100 }
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        const contacts = await client.listContacts(filterParams);
        return {
          content: [{ type: 'text', text: JSON.stringify(contacts, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // PROJECT TOOLS
  // ============================================

  tool(
    'harvest_list_projects',
    'List all projects',
    {
      client_id: z.number().optional().describe('Filter by client ID'),
      is_active: z.boolean().optional().describe('Filter by active status'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const { auto_paginate, ...filterParams } = params;
        
        if (auto_paginate) {
          const result = await client.autoPaginate(
            (p) => client.listProjects({ ...filterParams, ...p }),
            filterParams,
            { maxPages: 10, perPage: params.per_page || 100 }
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        const projects = await client.listProjects(filterParams);
        return {
          content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // INVOICE TOOLS
  // ============================================

  tool(
    'harvest_list_invoices',
    'List invoices with optional filters',
    {
      client_id: z.number().optional().describe('Filter by client ID'),
      project_id: z.number().optional().describe('Filter by project ID'),
      state: z.enum(['draft', 'open', 'paid', 'closed']).optional().describe('Filter by invoice state'),
      from: isoDate.optional().describe('Issue date from (YYYY-MM-DD)'),
      to: isoDate.optional().describe('Issue date to (YYYY-MM-DD)'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const { auto_paginate, ...filterParams } = params;
        
        if (auto_paginate) {
          const result = await client.autoPaginate(
            (p) => client.listInvoices({ ...filterParams, ...p }),
            filterParams,
            { maxPages: 10, perPage: params.per_page || 100 }
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        const invoices = await client.listInvoices(filterParams);
        return {
          content: [{ type: 'text', text: JSON.stringify(invoices, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_create_invoice',
    'Create a new invoice for a client. Supports two modes: (1) free-form line_items where you specify items manually, and (2) line_items_import to auto-generate line items from tracked time and/or expenses for given projects and date range. You can also combine both. Invoice is created in draft state.',
    {
      client_id: z.number().describe('Client ID to invoice (required)'),
      subject: z.string().optional().describe('Invoice subject/title'),
      notes: z.string().optional().describe('Invoice notes (appears on invoice)'),
      number: z.string().optional().describe('Custom invoice number (auto-generated if omitted)'),
      purchase_order: z.string().optional().describe('Purchase order number'),
      currency: z.string().optional().describe('Currency code (e.g., USD). Defaults to client currency.'),
      issue_date: isoDate.optional().describe('Issue date (YYYY-MM-DD). Defaults to today.'),
      due_date: isoDate.optional().describe('Due date (YYYY-MM-DD). Calculated from payment_term if omitted.'),
      payment_term: z.string().optional().describe('Payment term: "upon receipt", "net 15", "net 30", "net 45", "net 60", or "custom"'),
      tax: z.number().optional().describe('Tax rate as a percentage (e.g., 5 for 5%)'),
      tax2: z.number().optional().describe('Second tax rate as a percentage'),
      discount: z.number().optional().describe('Discount as a percentage'),
      retainer_id: z.number().optional().describe('Retainer ID to draw from'),
      estimate_id: z.number().optional().describe('Estimate ID this invoice is associated with'),
      line_items: z.array(z.object({
        kind: z.string().describe('Line item kind: "Service" or "Product"'),
        description: z.string().describe('Line item description'),
        unit_price: z.number().describe('Unit price'),
        quantity: z.number().optional().describe('Quantity (default 1)'),
        project_id: z.number().optional().describe('Project ID to associate this line item with'),
        taxed: z.boolean().optional().describe('Apply primary tax to this line item'),
        taxed2: z.boolean().optional().describe('Apply secondary tax to this line item'),
      })).optional().describe('Free-form line items to add to the invoice'),
      line_items_import: z.object({
        project_ids: z.array(z.number()).describe('Project IDs to import time/expenses from'),
        time: z.object({
          summary_type: z.enum(['project', 'task', 'people', 'detailed']).describe('How to group time entries into line items'),
          from: isoDate.optional().describe('Start date (YYYY-MM-DD)'),
          to: isoDate.optional().describe('End date (YYYY-MM-DD)'),
        }).optional().describe('Import tracked time as line items'),
        expenses: z.object({
          summary_type: z.enum(['project', 'category', 'people', 'detailed']).describe('How to group expenses into line items'),
          from: isoDate.optional().describe('Start date (YYYY-MM-DD)'),
          to: isoDate.optional().describe('End date (YYYY-MM-DD)'),
          attach_receipt: z.boolean().optional().describe('Attach expense receipts to invoice'),
        }).optional().describe('Import expenses as line items'),
      }).optional().describe('Auto-generate line items from tracked time and/or expenses for the given projects'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const invoice = await client.createInvoice(params);
        return {
          content: [{ type: 'text', text: JSON.stringify(invoice, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_add_invoice_line_items',
    'Add, update, or remove line items on an existing invoice. Pass an array of line_items: omit id to ADD a new item, include id to UPDATE an existing item, or include id with _destroy=true to REMOVE an item. Operations can be mixed in one call. Updates the invoice in place and returns the updated invoice.',
    {
      invoice_id: z.number().describe('Invoice ID to modify'),
      line_items: z.array(z.object({
        id: z.number().optional().describe('Existing line item ID. Omit to add a new item; include to update or destroy.'),
        _destroy: z.boolean().optional().describe('Set true with id to remove this line item'),
        kind: z.string().optional().describe('Line item kind: "Service" or "Product" (required for new items)'),
        description: z.string().optional().describe('Line item description (required for new items)'),
        unit_price: z.number().optional().describe('Unit price (required for new items)'),
        quantity: z.number().optional().describe('Quantity'),
        project_id: z.number().optional().describe('Project ID to associate with this line item'),
        taxed: z.boolean().optional().describe('Apply primary tax'),
        taxed2: z.boolean().optional().describe('Apply secondary tax'),
      })).describe('Line items to add, update, or remove'),
    },
    async ({ invoice_id, line_items }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const invoice = await client.updateInvoiceLineItems(invoice_id, line_items);
        return {
          content: [{ type: 'text', text: JSON.stringify(invoice, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_update_invoice',
    'Update an existing invoice. Provide the invoice ID plus any fields to change.',
    {
      invoice_id: z.number().describe('Invoice ID to update'),
      subject: z.string().optional().describe('Invoice subject/title'),
      notes: z.string().optional().describe('Invoice notes (appears on invoice)'),
      issue_date: isoDate.optional().describe('Issue date (YYYY-MM-DD)'),
      due_date: isoDate.optional().describe('Due date (YYYY-MM-DD)'),
      payment_term: z.string().optional().describe('Payment term: "upon receipt", "net 15", "net 30", "net 45", "net 60", or "custom"'),
      period_start: isoDate.optional().describe('Start of the period this invoice covers (YYYY-MM-DD)'),
      period_end: isoDate.optional().describe('End of the period this invoice covers (YYYY-MM-DD)'),
      discount: z.number().optional().describe('Discount as a percentage'),
      purchase_order: z.string().optional().describe('Purchase order number'),
      number: z.string().optional().describe('Custom invoice number'),
    },
    async ({ invoice_id, ...updates }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const invoice = await client.updateInvoice(invoice_id, updates);
        return {
          content: [{ type: 'text', text: JSON.stringify(invoice, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_delete_invoice',
    'Delete an invoice. Use this to remove a draft or erroneous invoice. This cannot be undone.',
    {
      invoice_id: z.number().describe('Invoice ID to delete'),
    },
    async ({ invoice_id }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        await client.deleteInvoice(invoice_id);
        return {
          content: [{ type: 'text', text: `Invoice ${invoice_id} has been deleted successfully.` }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // EXPENSE TOOLS
  // ============================================

  tool(
    'harvest_list_expenses',
    'List expenses with optional filters',
    {
      user_id: z.number().optional().describe('Filter by user ID'),
      client_id: z.number().optional().describe('Filter by client ID'),
      project_id: z.number().optional().describe('Filter by project ID'),
      is_billed: z.boolean().optional().describe('Filter by billed status'),
      from: isoDate.optional().describe('Spent date from (YYYY-MM-DD)'),
      to: isoDate.optional().describe('Spent date to (YYYY-MM-DD)'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const { auto_paginate, ...filterParams } = params;
        
        if (auto_paginate) {
          const result = await client.autoPaginate(
            (p) => client.listExpenses({ ...filterParams, ...p }),
            filterParams,
            { maxPages: 10, perPage: params.per_page || 100 }
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        const expenses = await client.listExpenses(filterParams);
        return {
          content: [{ type: 'text', text: JSON.stringify(expenses, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // TASK TOOLS
  // ============================================

  tool(
    'harvest_list_tasks',
    'List all tasks (used for time entry assignment)',
    {
      is_active: z.boolean().optional().describe('Filter by active status'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const { auto_paginate, ...filterParams } = params;
        
        if (auto_paginate) {
          const result = await client.autoPaginate(
            (p) => client.listTasks({ ...filterParams, ...p }),
            filterParams,
            { maxPages: 10, perPage: params.per_page || 100 }
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        const tasks = await client.listTasks(filterParams);
        return {
          content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // RATES TOOLS
  // ============================================

  tool(
    'harvest_get_rates',
    'Get cost and billable rates for users and projects. Fetches from Harvest API with fallback to rates.json config file and DEFAULT_COST_RATE environment variable.',
    {
      user_id: z.number().optional().describe('Get rates for specific user ID'),
      project_id: z.number().optional().describe('Get rates for specific project ID'),
      include_all_users: z.boolean().optional().describe('Include rates for all active users'),
      include_all_projects: z.boolean().optional().describe('Include rates for all active projects'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        return authRequiredResult();
      }

      try {
        const ratesService = new RatesService(client);
        const rates = await ratesService.getRates(params);

        // Log warnings if any
        if (rates.warnings.length > 0) {
          console.warn('Rate resolution warnings:', rates.warnings);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(rates, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // ENTITY RESOLUTION TOOL
  // ============================================

  tool(
    'harvest_resolve_entities',
    'Resolve entity names to IDs using fuzzy matching. Searches clients, projects, users, and tasks by name with configurable confidence threshold. Useful for finding entities when you only have partial or approximate names.',
    {
      query: z.string().describe('Search query (entity name or partial name)'),
      types: z.array(z.enum(['client', 'project', 'user', 'task'])).optional()
        .describe('Filter to specific entity types (default: all types)'),
      min_confidence: z.number().min(0).max(1).optional()
        .describe('Minimum confidence score 0-1 (default: 0.5). Higher = stricter matching'),
      limit: z.number().min(1).max(20).optional()
        .describe('Maximum results per entity type (default: 5)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);
      if (!client) {
        return {
          content: [{ type: 'text', text: 'Not authenticated. Please authenticate first.' }],
          isError: true,
        };
      }

      try {
        const resolver = new EntityResolver(client);
        const result = await resolver.resolve({
          query: params.query,
          types: params.types,
          min_confidence: params.min_confidence,
          limit: params.limit,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // COMPUTE TOOLS
  // ============================================

  tool(
    'harvest_compute_profitability',
    'Compute profitability metrics for a date range. Supports three modes: time_based (hours * rates), invoice_based (actual invoices vs costs), and hybrid (invoices where available, time-based otherwise). Can group by client, project, user, task, date, week, or month.',
    {
      mode: z.enum(['time_based', 'invoice_based', 'hybrid'])
        .describe('Calculation mode: time_based (hours*rates), invoice_based (actual invoices), hybrid (invoices+unbilled)'),
      from: isoDate.describe('Start date (YYYY-MM-DD)'),
      to: isoDate.describe('End date (YYYY-MM-DD)'),
      client_id: z.number().optional().describe('Filter by client ID'),
      project_id: z.number().optional().describe('Filter by project ID'),
      user_id: z.number().optional().describe('Filter by user ID'),
      group_by: z.array(z.enum(['client', 'project', 'user', 'task', 'date', 'week', 'month'])).optional()
        .describe('Group results by dimensions (can nest multiple, e.g., ["client", "project"])'),
      include_non_billable: z.boolean().optional()
        .describe('Include non-billable time in cost calculations (default: false)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);
      if (!client) {
        return {
          content: [{ type: 'text', text: 'Not authenticated. Please authenticate first.' }],
          isError: true,
        };
      }

      try {
        const calculator = new ProfitabilityCalculator(client);
        const result = await calculator.calculate({
          mode: params.mode,
          date_range: { from: params.from, to: params.to },
          client_id: params.client_id,
          project_id: params.project_id,
          user_id: params.user_id,
          group_by: params.group_by,
          include_non_billable: params.include_non_billable,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_compute_utilization',
    'Compute utilization metrics for a date range. Shows how much of available capacity is being used, with billable vs non-billable breakdown. Can group by user, client, project, task, date, week, or month.',
    {
      from: isoDate.describe('Start date (YYYY-MM-DD)'),
      to: isoDate.describe('End date (YYYY-MM-DD)'),
      user_id: z.number().optional().describe('Filter by user ID'),
      project_id: z.number().optional().describe('Filter by project ID'),
      client_id: z.number().optional().describe('Filter by client ID'),
      group_by: z.array(z.enum(['client', 'project', 'user', 'task', 'date', 'week', 'month'])).optional()
        .describe('Group results by dimensions (can nest multiple, e.g., ["user", "project"])'),
      capacity_hours_per_day: z.number().optional()
        .describe('Hours available per day per user (default: 8)'),
      exclude_weekends: z.boolean().optional()
        .describe('Exclude weekends from capacity calculations (default: true)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);
      if (!client) {
        return {
          content: [{ type: 'text', text: 'Not authenticated. Please authenticate first.' }],
          isError: true,
        };
      }

      try {
        const calculator = new UtilizationCalculator(client);
        const result = await calculator.calculate({
          date_range: { from: params.from, to: params.to },
          user_id: params.user_id,
          project_id: params.project_id,
          client_id: params.client_id,
          group_by: params.group_by,
          capacity_hours_per_day: params.capacity_hours_per_day,
          exclude_weekends: params.exclude_weekends,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_aggregate_time',
    'Aggregate time entries by various dimensions. Simple convenience tool for getting total hours, entry counts, and billable amounts grouped by client, project, user, task, date, week, or month.',
    {
      from: isoDate.describe('Start date (YYYY-MM-DD)'),
      to: isoDate.describe('End date (YYYY-MM-DD)'),
      group_by: z.array(z.enum(['client', 'project', 'user', 'task', 'date', 'week', 'month']))
        .describe('Group results by dimensions (required, can nest multiple)'),
      client_id: z.number().optional().describe('Filter by client ID'),
      project_id: z.number().optional().describe('Filter by project ID'),
      user_id: z.number().optional().describe('Filter by user ID'),
      task_id: z.number().optional().describe('Filter by task ID'),
      billable_only: z.boolean().optional()
        .describe('Only include billable time entries (default: false)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);
      if (!client) {
        return {
          content: [{ type: 'text', text: 'Not authenticated. Please authenticate first.' }],
          isError: true,
        };
      }

      try {
        const calculator = new TimeAggregationCalculator(client);
        const result = await calculator.aggregate({
          date_range: { from: params.from, to: params.to },
          group_by: params.group_by,
          client_id: params.client_id,
          project_id: params.project_id,
          user_id: params.user_id,
          task_id: params.task_id,
          billable_only: params.billable_only,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  tool(
    'harvest_compute_budget_performance',
    'Analyze employee performance based on budget adherence per project. Compares actual hours logged vs user budget allocations, identifies top performers (under budget), and flags repeat offenders (consistently over budget). Use this for performance reviews, capacity planning, and identifying training needs.',
    {
      from: isoDate.describe('Start date (YYYY-MM-DD)'),
      to: isoDate.describe('End date (YYYY-MM-DD)'),
      client_id: z.number().optional().describe('Filter by client ID'),
      project_id: z.number().optional().describe('Filter by project ID'),
      user_id: z.number().optional().describe('Filter by user ID'),
      require_person_budget: z.boolean().optional()
        .describe('Only include projects with per-person budgets (budget_by=person). Default: false'),
      on_budget_tolerance_percent: z.number().optional()
        .describe('Tolerance percentage for "on budget" rating (default: 5). E.g., 5 means ±5% is considered on budget'),
      sort_by: z.enum(['variance_hours', 'variance_percent', 'actual_hours', 'user_name']).optional()
        .describe('Sort users by: variance_hours (default), variance_percent, actual_hours, or user_name'),
      sort_order: z.enum(['asc', 'desc']).optional()
        .describe('Sort order: asc or desc (default: desc for variance metrics, asc for others)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);
      if (!client) {
        return {
          content: [{ type: 'text', text: 'Not authenticated. Please authenticate first.' }],
          isError: true,
        };
      }

      try {
        const calculator = new BudgetPerformanceCalculator(client);
        const result = await calculator.calculate({
          date_range: { from: params.from, to: params.to },
          client_id: params.client_id,
          project_id: params.project_id,
          user_id: params.user_id,
          require_person_budget: params.require_person_budget,
          on_budget_tolerance_percent: params.on_budget_tolerance_percent,
          sort_by: params.sort_by,
          sort_order: params.sort_order,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          const detail = error.errorBody ? `\n${error.errorBody}` : '';
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}${detail}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  // ============================================
  // SCHEMA/DOCUMENTATION TOOLS
  // ============================================

  tool(
    'harvest_get_schema',
    'Get schema definitions, field types, and enum values for Harvest entities. Use to understand available fields, data types, and valid values. No authentication required.',
    {
      category: z.string().optional()
        .describe('Schema category: time_tracking, clients_projects, users, invoicing, compute, resolution'),
      entity: z.string().optional()
        .describe('Specific entity to describe: TimeEntry, Client, Project, User, Task, Invoice, Expense'),
      enum: z.string().optional()
        .describe('Specific enum to describe: invoice_state, budget_by, bill_by, profitability_mode, group_by, entity_type, match_type, rate_source'),
    },
    async (params) => {
      const result = getSchema({
        category: params.category,
        entity: params.entity,
        enum: params.enum,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ============================================
  // v0.2.0 ADDITIONS
  // ============================================

  /** Run a Harvest call with auth handling and uniform error results. */
  async function withClient(fn: (client: HarvestClient) => Promise<unknown>) {
    const client = await getHarvestClient(session, sessionStore, config);
    if (!client) return authRequiredResult();
    try {
      return jsonResult(await fn(client));
    } catch (error) {
      return apiErrorResult(error);
    }
  }

  const dateSchema = isoDate;

  // --- Reports API ---------------------------------------------------------

  tool(
    'harvest_report_time',
    'Harvest Reports API: total hours, billable hours and billable amounts grouped by clients, projects, tasks or team for a date range (max 1 year). Aggregated by Harvest itself, so totals are exact regardless of entry count. Prefer this over harvest_aggregate_time for billing totals.',
    {
      group: z.enum(['clients', 'projects', 'tasks', 'team']).describe('Grouping dimension'),
      from: dateSchema.describe('Start date (YYYY-MM-DD)'),
      to: dateSchema.describe('End date (YYYY-MM-DD)'),
      include_fixed_fee: z.boolean().optional().describe('Include billable amounts for fixed-fee projects'),
    },
    async ({ group, from, to, include_fixed_fee }) => withClient((client) =>
      client.autoPaginate(
        (p) => client.getTimeReport(group, { from, to, include_fixed_fee, ...p }),
        {},
        { maxPages: 10, perPage: 2000, itemsKey: 'results' }
      )
    )
  );

  tool(
    'harvest_report_uninvoiced',
    'Harvest Reports API: uninvoiced hours and amounts per project for a date range. Use before invoicing to find billable time and expenses not yet on an invoice. By default only projects with something uninvoiced are returned, with totals.',
    {
      from: dateSchema.describe('Start date (YYYY-MM-DD)'),
      to: dateSchema.describe('End date (YYYY-MM-DD)'),
      include_fixed_fee: z.boolean().optional().describe('Include fixed-fee projects'),
      client_id: z.number().optional().describe('Only this client'),
      include_zero: z.boolean().optional().describe('Also return projects with nothing uninvoiced (default false)'),
    },
    async ({ from, to, include_fixed_fee, client_id, include_zero }) => withClient(async (client) => {
      const report = await client.autoPaginate(
        (p) => client.getUninvoicedReport({ from, to, include_fixed_fee, ...p }),
        {},
        { maxPages: 10, perPage: 2000, itemsKey: 'results' }
      );
      const num = (v: unknown) => (typeof v === 'number' ? v : 0);
      const rows = (report.items as Array<Record<string, unknown>>).filter((r) =>
        (client_id === undefined || r.client_id === client_id) &&
        (include_zero || num(r.uninvoiced_hours) > 0 || num(r.uninvoiced_amount) > 0 || num(r.uninvoiced_expenses) > 0)
      );
      const round2 = (n: number) => Math.round(n * 100) / 100;
      return {
        from,
        to,
        projects_returned: rows.length,
        projects_in_report: report.items.length,
        totals: {
          uninvoiced_hours: round2(rows.reduce((t, r) => t + num(r.uninvoiced_hours), 0)),
          uninvoiced_amount: round2(rows.reduce((t, r) => t + num(r.uninvoiced_amount), 0)),
          uninvoiced_expenses: round2(rows.reduce((t, r) => t + num(r.uninvoiced_expenses), 0)),
        },
        truncated: report.truncated,
        ...(report.truncation_warning ? { truncation_warning: report.truncation_warning } : {}),
        results: rows,
      };
    })
  );

  tool(
    'harvest_report_project_budget',
    'Harvest Reports API: budget, amount spent and budget remaining for each project.',
    {
      is_active: z.boolean().optional().describe('Only active (true) or archived (false) projects'),
    },
    async ({ is_active }) => withClient((client) =>
      client.autoPaginate(
        (p) => client.getProjectBudgetReport({ is_active, ...p }),
        {},
        { maxPages: 10, perPage: 2000, itemsKey: 'results' }
      )
    )
  );

  tool(
    'harvest_report_expenses',
    'Harvest Reports API: expense totals grouped by clients, projects, categories or team for a date range (max 1 year).',
    {
      group: z.enum(['clients', 'projects', 'categories', 'team']).describe('Grouping dimension'),
      from: dateSchema.describe('Start date (YYYY-MM-DD)'),
      to: dateSchema.describe('End date (YYYY-MM-DD)'),
    },
    async ({ group, from, to }) => withClient((client) =>
      client.autoPaginate(
        (p) => client.getExpenseReport(group, { from, to, ...p }),
        {},
        { maxPages: 10, perPage: 2000, itemsKey: 'results' }
      )
    )
  );

  // --- Invoices and timers -----------------------------------------------------

  tool(
    'harvest_get_invoice',
    'Get a single invoice by ID, including line items.',
    { id: z.number().describe('Invoice ID') },
    async ({ id }) => withClient((client) => client.getInvoice(id))
  );

  tool(
    'harvest_restart_timer',
    'Restart a stopped timer on a time entry.',
    { id: z.number().describe('Time entry ID') },
    async ({ id }) => withClient((client) => client.restartTimeEntry(id))
  );

  // --- Clients and contacts ----------------------------------------------------

  tool(
    'harvest_create_client',
    'Create a new client.',
    {
      name: z.string().describe('Client name'),
      is_active: z.boolean().optional(),
      address: z.string().optional(),
      currency: z.string().optional().describe('ISO currency code, e.g. USD'),
    },
    async (params) => withClient((client) => client.createClient(params))
  );

  tool(
    'harvest_update_client',
    'Update a client. Only the fields provided are changed. Set is_active=false to archive.',
    {
      id: z.number().describe('Client ID'),
      name: z.string().optional(),
      is_active: z.boolean().optional(),
      address: z.string().optional(),
      currency: z.string().optional(),
    },
    async ({ id, ...rest }) => withClient((client) => client.updateClient(id, compact(rest)))
  );

  const contactFields = {
    title: z.string().optional(),
    last_name: z.string().optional(),
    email: z.string().optional(),
    phone_office: z.string().optional(),
    phone_mobile: z.string().optional(),
    fax: z.string().optional(),
  };

  tool(
    'harvest_create_contact',
    'Create a client contact.',
    {
      client_id: z.number().describe('Client ID'),
      first_name: z.string(),
      ...contactFields,
    },
    async (params) => withClient((client) => client.createContact(compact(params)))
  );

  tool(
    'harvest_update_contact',
    'Update a client contact. Only the fields provided are changed.',
    {
      id: z.number().describe('Contact ID'),
      client_id: z.number().optional(),
      first_name: z.string().optional(),
      ...contactFields,
    },
    async ({ id, ...rest }) => withClient((client) => client.updateContact(id, compact(rest)))
  );

  // --- Projects, tasks and assignments --------------------------------------

  const projectFields = {
    code: z.string().optional().describe('Project code, e.g. CON-1033'),
    is_fixed_fee: z.boolean().optional(),
    hourly_rate: z.number().optional(),
    budget: z.number().optional(),
    budget_is_monthly: z.boolean().optional(),
    notify_when_over_budget: z.boolean().optional(),
    over_budget_notification_percentage: z.number().optional(),
    show_budget_to_all: z.boolean().optional(),
    cost_budget: z.number().optional(),
    cost_budget_include_expenses: z.boolean().optional(),
    fee: z.number().optional().describe('Fixed fee amount (fixed-fee projects)'),
    notes: z.string().optional(),
    starts_on: dateSchema.optional(),
    ends_on: dateSchema.optional(),
  };
  const billBy = z.enum(['Project', 'Tasks', 'People', 'none']);
  const budgetBy = z.enum(['project', 'project_cost', 'task', 'task_fees', 'person', 'none']);

  tool(
    'harvest_create_project',
    'Create a project under a client. Required: client_id, name, is_billable, bill_by, budget_by.',
    {
      client_id: z.number(),
      name: z.string(),
      is_billable: z.boolean(),
      bill_by: billBy,
      budget_by: budgetBy,
      ...projectFields,
    },
    async (params) => withClient((client) => client.createProject(compact(params)))
  );

  tool(
    'harvest_update_project',
    'Update a project. Only the fields provided are changed. Set is_active=false to archive.',
    {
      id: z.number().describe('Project ID'),
      client_id: z.number().optional(),
      name: z.string().optional(),
      is_active: z.boolean().optional(),
      is_billable: z.boolean().optional(),
      bill_by: billBy.optional(),
      budget_by: budgetBy.optional(),
      ...projectFields,
    },
    async ({ id, ...rest }) => withClient((client) => client.updateProject(id, compact(rest)))
  );

  tool(
    'harvest_create_task',
    'Create a task (account-wide task list).',
    {
      name: z.string(),
      billable_by_default: z.boolean().optional(),
      default_hourly_rate: z.number().optional(),
      is_default: z.boolean().optional().describe('Add to future projects automatically'),
      is_active: z.boolean().optional(),
    },
    async (params) => withClient((client) => client.createTask(compact(params)))
  );

  tool(
    'harvest_update_task',
    'Update a task. Only the fields provided are changed.',
    {
      id: z.number().describe('Task ID'),
      name: z.string().optional(),
      billable_by_default: z.boolean().optional(),
      default_hourly_rate: z.number().optional(),
      is_default: z.boolean().optional(),
      is_active: z.boolean().optional(),
    },
    async ({ id, ...rest }) => withClient((client) => client.updateTask(id, compact(rest)))
  );

  tool(
    'harvest_list_project_task_assignments',
    'List the tasks assigned to a project (with billable flags and rates).',
    {
      project_id: z.number(),
      is_active: z.boolean().optional(),
    },
    async ({ project_id, is_active }) => withClient((client) =>
      client.autoPaginate(
        (p) => client.listProjectTaskAssignments(project_id, { is_active, ...p }),
        {},
        { maxPages: 5, perPage: 2000, itemsKey: 'task_assignments' }
      )
    )
  );

  tool(
    'harvest_assign_task_to_project',
    'Assign an existing task to a project so time can be logged against it.',
    {
      project_id: z.number(),
      task_id: z.number(),
      is_active: z.boolean().optional(),
      billable: z.boolean().optional(),
      hourly_rate: z.number().optional(),
      budget: z.number().optional(),
    },
    async ({ project_id, ...rest }) => withClient((client) =>
      client.createProjectTaskAssignment(project_id, compact(rest))
    )
  );

  tool(
    'harvest_list_project_user_assignments',
    'List the people assigned to a project.',
    {
      project_id: z.number(),
      is_active: z.boolean().optional(),
    },
    async ({ project_id, is_active }) => withClient((client) =>
      client.autoPaginate(
        (p) => client.listProjectUserAssignments(project_id, { is_active, ...p }),
        {},
        { maxPages: 5, perPage: 2000, itemsKey: 'user_assignments' }
      )
    )
  );

  tool(
    'harvest_assign_user_to_project',
    'Assign a user to a project (e.g., onboarding a team member to a client project).',
    {
      project_id: z.number(),
      user_id: z.number(),
      is_project_manager: z.boolean().optional(),
      use_default_rates: z.boolean().optional(),
      hourly_rate: z.number().optional(),
      budget: z.number().optional(),
    },
    async ({ project_id, ...rest }) => withClient((client) =>
      client.createProjectUserAssignment(project_id, compact(rest))
    )
  );

  // --- Expenses ------------------------------------------------------------------

  tool(
    'harvest_list_expense_categories',
    'List expense categories (needed to create expenses).',
    { is_active: z.boolean().optional() },
    async ({ is_active }) => withClient((client) =>
      client.autoPaginate(
        (p) => client.listExpenseCategories({ is_active, ...p }),
        {},
        { maxPages: 5, perPage: 2000, itemsKey: 'expense_categories' }
      )
    )
  );

  tool(
    'harvest_create_expense',
    'Create an expense on a project (e.g., a pass-through cost to bill the client). Provide total_cost, or units for unit-based categories.',
    {
      project_id: z.number(),
      expense_category_id: z.number(),
      spent_date: dateSchema.describe('YYYY-MM-DD'),
      user_id: z.number().optional().describe('Defaults to the authenticated user'),
      units: z.number().optional(),
      total_cost: z.number().optional(),
      notes: z.string().optional(),
      billable: z.boolean().optional(),
    },
    async (params) => withClient((client) => client.createExpense(compact(params)))
  );

  tool(
    'harvest_update_expense',
    'Update an expense. Only the fields provided are changed.',
    {
      id: z.number().describe('Expense ID'),
      project_id: z.number().optional(),
      expense_category_id: z.number().optional(),
      spent_date: dateSchema.optional(),
      units: z.number().optional(),
      total_cost: z.number().optional(),
      notes: z.string().optional(),
      billable: z.boolean().optional(),
    },
    async ({ id, ...rest }) => withClient((client) => client.updateExpense(id, compact(rest)))
  );

  tool(
    'harvest_delete_expense',
    'Delete an expense. Cannot be undone; fails if the expense is invoiced or locked.',
    { id: z.number().describe('Expense ID') },
    async ({ id }) => withClient(async (client) => {
      await client.deleteExpense(id);
      return { deleted: true, id };
    })
  );
}
