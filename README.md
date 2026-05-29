# Harvest MCP Server

Connect your AI assistant to [Harvest](https://www.getharvest.com/) time tracking. Query time entries, analyze profitability, track utilization, and manage your Harvest data through natural language.

**Live Server:** https://harvest-mcp.southleft.com

---

## Quick Start

### Claude Desktop (Recommended)

1. Open Claude Desktop → **Settings** → **Connectors**
2. Click **Add Connector**
3. Enter: `https://harvest-mcp.southleft.com/mcp`
4. Click **Connect**

On first use, you'll receive an OAuth link to connect your Harvest account.

### Claude Code CLI

```bash
claude mcp add --transport http harvest https://harvest-mcp.southleft.com/mcp
```

### Manual Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "harvest": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://harvest-mcp.southleft.com/mcp"]
    }
  }
}
```

---

## Example Prompts

### Time Tracking

> "What did I work on today?"

> "Show me all my time entries from last week"

> "How many hours did I log on the Acme project this month?"

> "Start a timer for the Design task on Project X"

> "Stop my running timer"

### Team & Client Analysis

> "Who on my team logged the most hours last month?"

> "Show me all time entries for client Acme Corp"

> "Get the contact information for everyone at Initech"

> "What projects is Sarah working on?"

> "List all active clients"

### Profitability & Utilization

> "What's our profitability on the Acme project this quarter?"

> "Compare profitability across all clients for 2024"

> "What's our team utilization rate this month?"

> "Show me billable vs non-billable breakdown by team member"

> "Which projects are most profitable?"

### Budget Performance

> "Which employees went over their project budgets this quarter?"

> "Show me top performers who came in under budget"

> "Who are the repeat offenders going over budget on multiple projects?"

> "Compare budget variance by team member for 2024"

### Invoicing & Expenses

> "Show me all unpaid invoices"

> "What invoices are open for Acme Corp?"

> "List all expenses for the Johnson project"

> "What's been billed vs unbilled this quarter?"

### Aggregation & Reporting

> "Sum up hours by project for November"

> "Break down time by client and user for Q4"

> "Weekly hours summary for December"

> "Show me time trends by month for 2024"

---

## Available Tools (22)

### Time Tracking
| Tool | Description |
|------|-------------|
| `harvest_list_time_entries` | List and filter time entries by user, client, project, date range |
| `harvest_get_time_entry` | Get a specific time entry by ID |
| `harvest_create_time_entry` | Create new time entries with optional timer |
| `harvest_update_time_entry` | Update an existing time entry |
| `harvest_stop_timer` | Stop a running timer |
| `harvest_delete_time_entry` | Delete a time entry |

### Company & Team
| Tool | Description |
|------|-------------|
| `harvest_get_company` | Get company/account information |
| `harvest_get_current_user` | Get current user info |
| `harvest_list_users` | List all users with filters |

### Clients & Contacts
| Tool | Description |
|------|-------------|
| `harvest_list_clients` | List all clients |
| `harvest_list_contacts` | List client contacts (people associated with clients) |

### Projects & Tasks
| Tool | Description |
|------|-------------|
| `harvest_list_projects` | List all projects with filters |
| `harvest_list_tasks` | List all tasks |

### Invoicing & Expenses
| Tool | Description |
|------|-------------|
| `harvest_list_invoices` | List invoices with state/date filters |
| `harvest_list_expenses` | List expenses with filters |

### Analytics & Compute
| Tool | Description |
|------|-------------|
| `harvest_compute_profitability` | Calculate profitability (time-based, invoice-based, or hybrid) |
| `harvest_compute_utilization` | Calculate utilization with capacity tracking |
| `harvest_aggregate_time` | Aggregate time by client, project, user, date, week, or month |
| `harvest_compute_budget_performance` | Analyze employee performance based on budget adherence per project |

### Utilities
| Tool | Description |
|------|-------------|
| `harvest_get_rates` | Get cost and billable rates with fallback support |
| `harvest_resolve_entities` | Fuzzy search for entities by name |
| `harvest_get_schema` | Get schema definitions and enum values (no auth required) |

---

## Self-Hosting

### Cloudflare Workers (Recommended)

1. **Clone and install**
   ```bash
   git clone https://github.com/southleft/harvest-mcp.git
   cd harvest-mcp
   npm install
   ```

2. **Create Harvest OAuth App**
   - Go to [Harvest Developers](https://id.getharvest.com/developers)
   - Create a new OAuth2 application
   - Set redirect URI to `https://your-worker.workers.dev/callback`
   - Note your Client ID and Client Secret

3. **Configure Cloudflare**
   ```bash
   # Update wrangler.toml with your account_id

   # Create KV namespaces
   npx wrangler kv:namespace create SESSIONS
   npx wrangler kv:namespace create RATES_CONFIG

   # Update wrangler.toml with the namespace IDs

   # Set secrets
   echo "YOUR_CLIENT_ID" | npx wrangler secret put HARVEST_CLIENT_ID
   echo "YOUR_CLIENT_SECRET" | npx wrangler secret put HARVEST_CLIENT_SECRET
   echo "YOUR_SESSION_SECRET" | npx wrangler secret put SESSION_SECRET
   ```

4. **Deploy**
   ```bash
   npm run deploy
   ```

### Node.js Server

```bash
cp .env.example .env
# Edit .env with your Harvest credentials

npm run dev      # Development
npm run build && npm start  # Production
```

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `HARVEST_CLIENT_ID` | Harvest OAuth Client ID | Yes |
| `HARVEST_CLIENT_SECRET` | Harvest OAuth Client Secret | Yes |
| `SESSION_SECRET` | Secret for session encryption | Yes |
| `SESSION_TTL_HOURS` | Session lifetime (default: 24) | No |
| `ALLOWED_ORIGINS` | CORS allowed origins | No |
| `DEFAULT_COST_RATE` | Fallback cost rate | No |

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude/MCP     │────▶│  Cloudflare      │────▶│  Harvest        │
│  Client         │◀────│  Workers         │◀────│  API            │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │  Cloudflare KV   │
                        │  (Sessions)      │
                        └──────────────────┘
```

**Stack:**
- [Hono](https://hono.dev/) - Web framework
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) - Model Context Protocol
- [Cloudflare KV](https://developers.cloudflare.com/kv/) - Session storage
- [Harvest API v2](https://help.getharvest.com/api-v2/) - Time tracking API

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing page |
| `/health` | GET | Health check |
| `/mcp` | POST | MCP protocol endpoint |
| `/callback` | GET | OAuth callback |

---

## Development

```bash
npm install           # Install dependencies
npm run dev:workers   # Run locally with wrangler
npm test              # Run tests
npm run lint          # Lint code
npm run format        # Format code
```

---

## Project Structure

```
src/
├── workers/          # Cloudflare Workers entry point
│   ├── index.ts      # Hono app with MCP endpoint
│   ├── config.ts     # Workers config loader
│   └── kv-session-store.ts
├── tools/            # MCP tool implementations
│   └── index.ts      # All tool registrations
├── harvest/          # Harvest API client
│   ├── client.ts     # API client with caching
│   ├── types.ts      # TypeScript types
│   ├── cache.ts      # LRU cache
│   └── rate-limiter.ts
├── compute/          # Analytics engines
│   ├── profitability.ts
│   ├── utilization.ts
│   └── aggregation.ts
├── auth/             # OAuth implementation
├── session/          # Session management
├── rates/            # Rate resolution service
├── entities/         # Entity resolution (fuzzy search)
└── schema/           # Schema documentation
```

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Built by [Southleft](https://southleft.com)
