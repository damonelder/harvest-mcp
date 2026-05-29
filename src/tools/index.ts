/**
 * MCP Tool Registration
 *
 * Registers all Harvest API tools with the MCP server
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { Session, SessionStore } from '../session/types.js';
import type { Config } from '../config.js';
import { HarvestClient, HarvestApiError } from '../harvest/client.js';
import { HarvestOAuth } from '../auth/oauth.js';
import { RatesService } from '../rates/index.js';
import { EntityResolver } from '../entities/index.js';
import { ProfitabilityCalculator, UtilizationCalculator, TimeAggregationCalculator, BudgetPerformanceCalculator } from '../compute/index.js';
import { getSchema } from '../schema/index.js';

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
  const now = new Date();
  const expiresAt = new Date(session.tokenExpiresAt);
  const bufferMs = 5 * 60 * 1000; // 5 minutes

  if (now.getTime() + bufferMs >= expiresAt.getTime()) {
    // Token expired or expiring soon, try to refresh
    try {
      const oauth = new HarvestOAuth(config.harvest);
      const newTokens = await oauth.refreshToken(session.harvestRefreshToken);

      session.harvestAccessToken = newTokens.access_token;
      session.harvestRefreshToken = newTokens.refresh_token;
      session.tokenExpiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

      await sessionStore.set(session.id, session);
    } catch (error) {
      console.error('Token refresh failed:', error);
      // Clear tokens to trigger re-authentication
      session.harvestAccessToken = '';
      await sessionStore.set(session.id, session);
      return null;
    }
  }

  return new HarvestClient(
    session.harvestAccessToken,
    session.harvestAccountId,
    { userAgent: 'HarvestMCP/0.1.0' }
  );
}

/**
 * Helper to generate authentication URL for elicitation
 */
function getAuthUrl(session: Session, config: Config): string {
  const oauth = new HarvestOAuth(config.harvest);
  const state = HarvestOAuth.generateState(session.id);
  return oauth.getAuthorizationUrl(state);
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

  // Registered first so it is always present in the active tool context.
  // claude.ai's tool_search only surfaces subsets of a large manifest, so
  // calling harvest_init at the start of a billing session pulls the full
  // list of Harvest tool names into context.
  const REGISTERED_TOOLS = [
    'harvest_init',
    'harvest_get_company',
    'harvest_get_current_user',
    'harvest_list_users',
    'harvest_list_time_entries',
    'harvest_get_time_entry',
    'harvest_create_time_entry',
    'harvest_stop_timer',
    'harvest_delete_time_entry',
    'harvest_update_time_entry',
    'harvest_list_clients',
    'harvest_list_contacts',
    'harvest_list_projects',
    'harvest_list_invoices',
    'harvest_create_invoice',
    'harvest_add_invoice_line_items',
    'harvest_list_expenses',
    'harvest_list_tasks',
    'harvest_get_rates',
    'harvest_resolve_entities',
    'harvest_compute_profitability',
    'harvest_compute_utilization',
    'harvest_aggregate_time',
    'harvest_compute_budget_performance',
    'harvest_get_schema',
  ];

  server.tool(
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

  server.tool(
    'harvest_get_company',
    'Get information about the authenticated Harvest company/account',
    {},
    async () => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const company = await client.getCompany();
        return {
          content: [{ type: 'text', text: JSON.stringify(company, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'harvest_get_current_user',
    'Get information about the currently authenticated Harvest user',
    {},
    async () => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const user = await client.getCurrentUser();
        return {
          content: [{ type: 'text', text: JSON.stringify(user, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
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
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
    'harvest_list_time_entries',
    'List time entries with optional filters (user, client, project, date range, etc.)',
    {
      user_id: z.number().optional().describe('Filter by user ID'),
      client_id: z.number().optional().describe('Filter by client ID'),
      project_id: z.number().optional().describe('Filter by project ID'),
      is_billed: z.boolean().optional().describe('Filter by billed status'),
      is_running: z.boolean().optional().describe('Filter by running timer'),
      from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      to: z.string().optional().describe('End date (YYYY-MM-DD)'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page (1-2000)'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'harvest_get_time_entry',
    'Get a specific time entry by ID',
    {
      id: z.number().describe('Time entry ID'),
    },
    async ({ id }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const timeEntry = await client.getTimeEntry(id);
        return {
          content: [{ type: 'text', text: JSON.stringify(timeEntry, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'harvest_create_time_entry',
    'Create a new time entry',
    {
      project_id: z.number().describe('Project ID'),
      task_id: z.number().describe('Task ID'),
      spent_date: z.string().describe('Date (YYYY-MM-DD)'),
      hours: z.number().optional().describe('Hours to log (omit to start timer)'),
      notes: z.string().optional().describe('Notes/description'),
      started_time: z.string().optional().describe('Start time (HH:MM, 12h format like "9:00am")'),
      ended_time: z.string().optional().describe('End time (HH:MM, 12h format like "5:00pm")'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const timeEntry = await client.createTimeEntry(params);
        return {
          content: [{ type: 'text', text: JSON.stringify(timeEntry, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'harvest_stop_timer',
    'Stop a running timer on a time entry',
    {
      id: z.number().describe('Time entry ID'),
    },
    async ({ id }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const timeEntry = await client.stopTimeEntry(id);
        return {
          content: [{ type: 'text', text: JSON.stringify(timeEntry, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'harvest_delete_time_entry',
    'Delete a time entry. Use this to remove erroneous or unwanted time entries.',
    {
      id: z.number().describe('Time entry ID to delete'),
    },
    async ({ id }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
      }

      try {
        await client.deleteTimeEntry(id);
        return {
          content: [{ type: 'text', text: `Time entry ${id} has been deleted successfully.` }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'harvest_update_time_entry',
    'Update an existing time entry. Provide the time entry ID plus any fields to change.',
    {
      id: z.number().describe('Time entry ID to update'),
      spent_date: z.string().optional().describe('Date (YYYY-MM-DD)'),
      hours: z.number().optional().describe('Hours logged'),
      notes: z.string().optional().describe('Notes/description'),
      project_id: z.number().optional().describe('Project ID'),
      task_id: z.number().optional().describe('Task ID'),
    },
    async ({ id, ...updates }) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const timeEntry = await client.updateTimeEntry(id, updates);
        return {
          content: [{ type: 'text', text: JSON.stringify(timeEntry, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
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
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
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
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
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
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
    'harvest_list_invoices',
    'List invoices with optional filters',
    {
      client_id: z.number().optional().describe('Filter by client ID'),
      project_id: z.number().optional().describe('Filter by project ID'),
      state: z.enum(['draft', 'open', 'paid', 'closed']).optional().describe('Filter by invoice state'),
      from: z.string().optional().describe('Issue date from (YYYY-MM-DD)'),
      to: z.string().optional().describe('Issue date to (YYYY-MM-DD)'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'harvest_create_invoice',
    'Create a new invoice for a client. Supports two modes: (1) free-form line_items where you specify items manually, and (2) line_items_import to auto-generate line items from tracked time and/or expenses for given projects and date range. You can also combine both. Invoice is created in draft state.',
    {
      client_id: z.number().describe('Client ID to invoice (required)'),
      subject: z.string().optional().describe('Invoice subject/title'),
      notes: z.string().optional().describe('Invoice notes (appears on invoice)'),
      number: z.string().optional().describe('Custom invoice number (auto-generated if omitted)'),
      purchase_order: z.string().optional().describe('Purchase order number'),
      currency: z.string().optional().describe('Currency code (e.g., USD). Defaults to client currency.'),
      issue_date: z.string().optional().describe('Issue date (YYYY-MM-DD). Defaults to today.'),
      due_date: z.string().optional().describe('Due date (YYYY-MM-DD). Calculated from payment_term if omitted.'),
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
          from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
          to: z.string().optional().describe('End date (YYYY-MM-DD)'),
        }).optional().describe('Import tracked time as line items'),
        expenses: z.object({
          summary_type: z.enum(['project', 'category', 'people', 'detailed']).describe('How to group expenses into line items'),
          from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
          to: z.string().optional().describe('End date (YYYY-MM-DD)'),
          attach_receipt: z.boolean().optional().describe('Attach expense receipts to invoice'),
        }).optional().describe('Import expenses as line items'),
      }).optional().describe('Auto-generate line items from tracked time and/or expenses for the given projects'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const invoice = await client.createInvoice(params);
        return {
          content: [{ type: 'text', text: JSON.stringify(invoice, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
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
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const invoice = await client.updateInvoiceLineItems(invoice_id, line_items);
        return {
          content: [{ type: 'text', text: JSON.stringify(invoice, null, 2) }],
        };
      } catch (error) {
        if (error instanceof HarvestApiError) {
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
    'harvest_list_expenses',
    'List expenses with optional filters',
    {
      user_id: z.number().optional().describe('Filter by user ID'),
      client_id: z.number().optional().describe('Filter by client ID'),
      project_id: z.number().optional().describe('Filter by project ID'),
      is_billed: z.boolean().optional().describe('Filter by billed status'),
      from: z.string().optional().describe('Spent date from (YYYY-MM-DD)'),
      to: z.string().optional().describe('Spent date to (YYYY-MM-DD)'),
      page: z.number().optional().describe('Page number'),
      per_page: z.number().optional().describe('Results per page'),
      auto_paginate: z.boolean().optional().describe('Automatically fetch all pages (max 10 pages)'),
    },
    async (params) => {
      const client = await getHarvestClient(session, sessionStore, config);

      if (!client) {
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
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
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
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
        const authUrl = getAuthUrl(session, config);
        return {
          content: [
            {
              type: 'text',
              text: `Authentication required. Please authorize the application:\n\n${authUrl}`,
            },
          ],
          isError: true,
        };
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
    'harvest_compute_profitability',
    'Compute profitability metrics for a date range. Supports three modes: time_based (hours * rates), invoice_based (actual invoices vs costs), and hybrid (invoices where available, time-based otherwise). Can group by client, project, user, task, date, week, or month.',
    {
      mode: z.enum(['time_based', 'invoice_based', 'hybrid'])
        .describe('Calculation mode: time_based (hours*rates), invoice_based (actual invoices), hybrid (invoices+unbilled)'),
      from: z.string().describe('Start date (YYYY-MM-DD)'),
      to: z.string().describe('End date (YYYY-MM-DD)'),
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'harvest_compute_utilization',
    'Compute utilization metrics for a date range. Shows how much of available capacity is being used, with billable vs non-billable breakdown. Can group by user, client, project, task, date, week, or month.',
    {
      from: z.string().describe('Start date (YYYY-MM-DD)'),
      to: z.string().describe('End date (YYYY-MM-DD)'),
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'harvest_aggregate_time',
    'Aggregate time entries by various dimensions. Simple convenience tool for getting total hours, entry counts, and billable amounts grouped by client, project, user, task, date, week, or month.',
    {
      from: z.string().describe('Start date (YYYY-MM-DD)'),
      to: z.string().describe('End date (YYYY-MM-DD)'),
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  server.tool(
    'harvest_compute_budget_performance',
    'Analyze employee performance based on budget adherence per project. Compares actual hours logged vs user budget allocations, identifies top performers (under budget), and flags repeat offenders (consistently over budget). Use this for performance reviews, capacity planning, and identifying training needs.',
    {
      from: z.string().describe('Start date (YYYY-MM-DD)'),
      to: z.string().describe('End date (YYYY-MM-DD)'),
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
          return {
            content: [{ type: 'text', text: `Harvest API error: ${error.message}` }],
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

  server.tool(
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
}
