/**
 * Harvest MCP Server - Cloudflare Workers Entry Point
 *
 * A remote MCP server running on Cloudflare Workers that provides
 * access to the Harvest time tracking API via OAuth2 authentication.
 *
 * Uses stateless MCP mode since Workers can't maintain persistent connections.
 * OAuth sessions are managed separately via KV storage.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import type { Env } from './types.js';
import { KVSessionStore } from './kv-session-store.js';
import { loadWorkersConfig } from './config.js';
import { HarvestOAuth } from '../auth/oauth.js';
import { registerTools } from '../tools/index.js';
import type { Session } from '../session/types.js';

// Create Hono app with environment type
const app = new Hono<{ Bindings: Env }>();

/**
 * CORS middleware - allows Claude Desktop and other MCP clients
 */
app.use('*', cors({
  origin: (origin, c) => {
    const allowedOrigins = c.env.ALLOWED_ORIGINS?.split(',') || ['https://claude.ai', 'https://app.claude.ai'];
    // Allow requests with no origin (like curl or same-origin)
    if (!origin) return '*';
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return origin;
    }
    // Allow any origin for OAuth discovery (needed for Claude Desktop connectors)
    return origin;
  },
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'mcp-session-id', 'x-harvest-session', 'Authorization', 'Last-Event-ID', 'mcp-protocol-version'],
  exposeHeaders: ['mcp-session-id', 'x-harvest-session', 'mcp-protocol-version', 'WWW-Authenticate'],
  credentials: true,
  maxAge: 86400,
}));

/**
 * Root endpoint - landing page
 */
app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Harvest MCP Server - Connect Harvest to Any MCP Client</title>
        <meta name="description" content="A Model Context Protocol server that enables AI assistants to interact with your Harvest time tracking data through natural conversation.">

        <!-- Open Graph / Facebook -->
        <meta property="og:type" content="website">
        <meta property="og:url" content="https://harvest-mcp.southleft.com/">
        <meta property="og:title" content="Harvest MCP Server">
        <meta property="og:description" content="Connect Harvest to any MCP client. Query time entries, analyze profitability, track utilization, and manage your Harvest data through natural conversation.">
        <meta property="og:image" content="https://harvest-mcp.southleft.com/og-image.png">
        <meta property="og:image:width" content="1200">
        <meta property="og:image:height" content="630">

        <!-- Twitter -->
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:url" content="https://harvest-mcp.southleft.com/">
        <meta name="twitter:title" content="Harvest MCP Server">
        <meta name="twitter:description" content="Connect Harvest to any MCP client. Query time entries, analyze profitability, track utilization, and manage your Harvest data through natural conversation.">
        <meta name="twitter:image" content="https://harvest-mcp.southleft.com/og-image.png">

        <link rel="canonical" href="https://harvest-mcp.southleft.com/">
        <link rel="icon" type="image/png" href="/icon.png">
        <link rel="shortcut icon" href="/favicon.ico">
        <link rel="apple-touch-icon" href="/icon.png">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
        <style>
          :root {
            --orange: #FA5D00;
            --orange-light: #FFF4ED;
            --white: #FFFFFF;
            --gray-50: #FAFAFA;
            --gray-100: #F5F5F5;
            --gray-200: #E5E5E5;
            --gray-400: #A3A3A3;
            --gray-500: #737373;
            --gray-600: #525252;
            --gray-900: #171717;
            --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
            --font-mono: 'IBM Plex Mono', 'SF Mono', Consolas, monospace;
          }

          * { margin: 0; padding: 0; box-sizing: border-box; }

          body {
            font-family: var(--font-sans);
            font-size: 16px;
            color: var(--gray-900);
            line-height: 1.6;
            background: var(--white);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            -webkit-font-smoothing: antialiased;
          }

          a {
            color: var(--orange);
            text-decoration: none;
          }
          a:hover { text-decoration: underline; }

          /* Header */
          header {
            padding: 20px 48px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid var(--gray-200);
          }

          .logo {
            display: flex;
            align-items: center;
            gap: 12px;
            text-decoration: none;
          }

          .logo img {
            width: 32px;
            height: 32px;
          }

          .logo-text {
            font-size: 18px;
            font-weight: 600;
            color: var(--gray-900);
          }

          .logo-text span {
            color: var(--gray-400);
            font-weight: 500;
          }

          .header-links {
            display: flex;
            align-items: center;
            gap: 24px;
          }

          .header-links a {
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--gray-600);
            font-size: 14px;
            font-weight: 500;
          }

          .header-links a:hover {
            color: var(--gray-900);
            text-decoration: none;
          }

          .header-links svg {
            width: 18px;
            height: 18px;
          }

          /* Main Grid Layout */
          main {
            flex: 1;
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-template-rows: auto auto;
            gap: 0;
            max-width: 1400px;
            margin: 0 auto;
            width: 100%;
          }

          /* Left Column - Hero */
          .hero {
            padding: 80px 64px 64px 48px;
            display: flex;
            flex-direction: column;
            justify-content: center;
          }

          .hero h1 {
            font-size: 48px;
            font-weight: 700;
            color: var(--gray-900);
            line-height: 1.1;
            letter-spacing: -0.03em;
            margin-bottom: 20px;
          }

          .hero h1 span {
            color: var(--orange);
          }

          .hero-description {
            font-size: 18px;
            color: var(--gray-600);
            line-height: 1.6;
            max-width: 440px;
          }

          /* Right Column - Endpoint */
          .endpoint-section {
            padding: 80px 48px 64px 64px;
            display: flex;
            flex-direction: column;
            justify-content: center;
          }

          .endpoint-label {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            color: var(--gray-500);
            margin-bottom: 12px;
          }

          .endpoint-box {
            background: var(--gray-50);
            border: 1px solid var(--gray-200);
            border-radius: 8px;
            padding: 16px 20px;
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 32px;
          }

          .endpoint-box code {
            flex: 1;
            font-family: var(--font-mono);
            font-size: 14px;
            font-weight: 500;
            color: var(--gray-900);
          }

          .copy-btn {
            background: var(--orange);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            font-family: var(--font-sans);
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.15s;
            display: flex;
            align-items: center;
            gap: 6px;
          }

          .copy-btn:hover {
            background: #E54D00;
          }

          .copy-btn svg {
            width: 14px;
            height: 14px;
          }

          .setup-steps {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .step {
            display: flex;
            gap: 12px;
            align-items: flex-start;
          }

          .step-num {
            width: 24px;
            height: 24px;
            background: var(--orange-light);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: 600;
            color: var(--orange);
            flex-shrink: 0;
          }

          .step-text {
            font-size: 14px;
            color: var(--gray-600);
            padding-top: 2px;
          }

          .step-text strong {
            color: var(--gray-900);
            font-weight: 600;
          }

          /* Bottom Section - Full Width */
          .bottom-section {
            grid-column: 1 / -1;
            display: grid;
            grid-template-columns: 1fr 1fr;
            border-top: 1px solid var(--gray-200);
          }

          /* Capabilities */
          .capabilities-section {
            padding: 48px 64px 48px 48px;
            border-right: 1px solid var(--gray-200);
          }

          .section-title {
            font-size: 13px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--gray-500);
            margin-bottom: 24px;
          }

          .capabilities-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
          }

          .capability {
            display: flex;
            gap: 12px;
            align-items: flex-start;
          }

          .capability-icon {
            width: 36px;
            height: 36px;
            background: var(--gray-100);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }

          .capability-icon svg {
            width: 18px;
            height: 18px;
            color: var(--gray-600);
          }

          .capability-content h3 {
            font-size: 14px;
            font-weight: 600;
            color: var(--gray-900);
            margin-bottom: 2px;
          }

          .capability-content p {
            font-size: 13px;
            color: var(--gray-500);
            line-height: 1.4;
          }

          /* Example Prompts */
          .prompts-section {
            padding: 48px 48px 48px 64px;
          }

          .prompts-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .prompt {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            background: var(--gray-50);
            border-radius: 8px;
            font-size: 14px;
            color: var(--gray-900);
          }

          .prompt svg {
            width: 16px;
            height: 16px;
            color: var(--orange);
            flex-shrink: 0;
          }

          /* Footer */
          footer {
            border-top: 1px solid var(--gray-200);
            padding: 24px 48px;
            display: flex;
            align-items: center;
            justify-content: space-between;
          }

          .made-with {
            font-size: 14px;
            color: var(--gray-500);
          }

          .made-with a {
            color: var(--gray-900);
            font-weight: 500;
          }

          .footer-links {
            display: flex;
            gap: 24px;
          }

          .footer-links a {
            font-size: 13px;
            color: var(--gray-500);
            font-weight: 500;
          }

          .footer-links a:hover {
            color: var(--gray-900);
          }

          /* Responsive */
          @media (max-width: 1024px) {
            main {
              grid-template-columns: 1fr;
            }

            .hero {
              padding: 48px 32px;
            }

            .hero h1 {
              font-size: 36px;
            }

            .endpoint-section {
              padding: 0 32px 48px;
            }

            .bottom-section {
              grid-template-columns: 1fr;
            }

            .capabilities-section {
              padding: 32px;
              border-right: none;
              border-bottom: 1px solid var(--gray-200);
            }

            .capabilities-grid {
              grid-template-columns: 1fr;
            }

            .prompts-section {
              padding: 32px;
            }

            header, footer {
              padding: 16px 24px;
            }
          }
        </style>
      </head>
      <body>
        <header>
          <a href="/" class="logo">
            <img src="/icon.png" alt="Harvest">
            <div class="logo-text">Harvest <span>MCP</span></div>
          </a>
          <div class="header-links">
            <a href="https://github.com/southleft/harvest-mcp#available-tools-22" target="_blank">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
              22 Tools
            </a>
            <a href="https://github.com/southleft/harvest-mcp" target="_blank">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
              GitHub
            </a>
          </div>
        </header>

        <main>
          <section class="hero">
            <h1>Connect <span>Harvest</span> to any MCP client</h1>
            <p class="hero-description">
              A Model Context Protocol server that enables AI assistants to interact with your Harvest time tracking data through natural conversation.
            </p>
          </section>

          <section class="endpoint-section">
            <div class="endpoint-label">MCP Endpoint</div>
            <div class="endpoint-box">
              <code>https://harvest-mcp.southleft.com/mcp</code>
              <button class="copy-btn" onclick="navigator.clipboard.writeText('https://harvest-mcp.southleft.com/mcp').then(() => { this.innerHTML = '<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'><polyline points=\\'20 6 9 17 4 12\\'></polyline></svg> Copied'; setTimeout(() => this.innerHTML = '<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'><rect width=\\'14\\' height=\\'14\\' x=\\'8\\' y=\\'8\\' rx=\\'2\\' ry=\\'2\\'/><path d=\\'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\\'/></svg> Copy', 2000); })">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                Copy
              </button>
            </div>
            <div class="setup-steps">
              <div class="step">
                <div class="step-num">1</div>
                <div class="step-text">Add the endpoint URL to your <strong>MCP client settings</strong></div>
              </div>
              <div class="step">
                <div class="step-num">2</div>
                <div class="step-text">Connect and authorize with your <strong>Harvest account</strong></div>
              </div>
              <div class="step">
                <div class="step-num">3</div>
                <div class="step-text">Start asking questions about your <strong>time data</strong></div>
              </div>
            </div>
          </section>

          <div class="bottom-section">
            <section class="capabilities-section">
              <h2 class="section-title">Capabilities</h2>
              <div class="capabilities-grid">
                <div class="capability">
                  <div class="capability-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  </div>
                  <div class="capability-content">
                    <h3>Time Tracking</h3>
                    <p>Create entries, start/stop timers, query timesheets</p>
                  </div>
                </div>
                <div class="capability">
                  <div class="capability-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/></svg>
                  </div>
                  <div class="capability-content">
                    <h3>Analytics</h3>
                    <p>Profitability, utilization, time aggregation</p>
                  </div>
                </div>
                <div class="capability">
                  <div class="capability-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                  </div>
                  <div class="capability-content">
                    <h3>Data Access</h3>
                    <p>Clients, projects, users, invoices, expenses</p>
                  </div>
                </div>
                <div class="capability">
                  <div class="capability-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                  </div>
                  <div class="capability-content">
                    <h3>Smart Search</h3>
                    <p>Find entities by name with fuzzy matching</p>
                  </div>
                </div>
              </div>
            </section>

            <section class="prompts-section">
              <h2 class="section-title">Example Prompts</h2>
              <div class="prompts-list">
                <div class="prompt">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                  What did I work on last week?
                </div>
                <div class="prompt">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                  How profitable was the Acme project this quarter?
                </div>
                <div class="prompt">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                  Show me my team's utilization for November
                </div>
                <div class="prompt">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                  Start a timer for design work on Project X
                </div>
                <div class="prompt">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                  Who logged the most hours this month?
                </div>
              </div>
            </section>
          </div>
        </main>

        <footer>
          <div class="made-with">
            Made with ❤️ by <a href="https://southleft.com" target="_blank">Southleft</a>
          </div>
          <div class="footer-links">
            <a href="https://github.com/southleft/harvest-mcp" target="_blank">GitHub</a>
            <a href="https://www.getharvest.com" target="_blank">Harvest</a>
          </div>
        </footer>
      </body>
    </html>
  `);
});

/**
 * Health check endpoint
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    runtime: 'cloudflare-workers',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Harvest logo icon - served from same origin for MCP icon requirements
 * Base64-encoded PNG of Harvest's apple-touch-icon (180x180)
 */
const HARVEST_ICON_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAAAPFBMVEX6XQD/+PH/7uL/5dP+28T+28P+0bX+x6b9vpb9tYf9tIj9qnj8oGn8l1r7l1r8jkv8hDz7ei37cB77Zw+k35VPAAABoUlEQVR42u3cTW4CMQxAYXtChxRnmJDc/65dRPy0REhIiYTV95Ze2PouYCEiIiIiIiIiIiIiIiIi+tiyxVaSezWdYivLu9XYehydr+s2Gdwe9Np6v3fSW+9fLNqSW7botShjM9VnQAk6FBBVZwE27QGiDgWYzgOEHmDXoYCi8wC79gDHsQCbCLAu4DAWsE4ExC5AAQAAAAAAAAAAAAAAAAAAAAAA/AFqOh48A9KiLacAU3UN2NQ5IDgHXNQ5YPcOOAMAAAAAgNeAkrtVH4Bqi/bLLgAlqHoGlKC+AVF9A6o6B+zeAck7wAAAAAAAAAAAAAAAAACg0yLOAdE5IBTfgFDENWAt4gkQ7HfnKuIKsMrfAAAAAADAS8DuHVCcA1ZxDrg4B5i4BiybOAZ8xVTFM6CICAAAAAAAAAAAAAAAAAAAAADgHwIW74BDF2ATAWksIHYBeSKgjAWUHiDIPIDJUMC39AD7PECUoYC19gAmswBLkpGAxUSeASHL4LbYOp3rI6tV5bG9DU1elLvrUmxZ5j0wEREREREREREREREREX1sP/+vQJawQ0UbAAAAAElFTkSuQmCC';

/**
 * Icon endpoint - serves Harvest logo PNG from same origin
 */
app.get('/icon.png', (c) => {
  const iconBuffer = Uint8Array.from(atob(HARVEST_ICON_PNG_BASE64), c => c.charCodeAt(0));
  return new Response(iconBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

/**
 * Favicon endpoint - serves Harvest logo as favicon
 */
app.get('/favicon.ico', (c) => {
  const iconBuffer = Uint8Array.from(atob(HARVEST_ICON_PNG_BASE64), c => c.charCodeAt(0));
  return new Response(iconBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

/**
 * Open Graph image for social sharing (1200x630)
 * This serves an SVG - for best compatibility, replace with a PNG hosted on a CDN
 */
app.get('/og-image.png', (c) => {
  const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#FFFFFF"/>
        <stop offset="100%" style="stop-color:#FFF8F2"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="630" fill="url(#bg)"/>
    <rect x="0" y="580" width="1200" height="50" fill="#FA5D00"/>
    <!-- Harvest Icon -->
    <g transform="translate(80, 200)">
      <rect width="80" height="80" rx="16" fill="#FA5D00"/>
      <rect x="18" y="24" width="8" height="32" fill="white"/>
      <rect x="36" y="16" width="8" height="40" fill="white"/>
      <rect x="54" y="28" width="8" height="28" fill="white"/>
    </g>
    <!-- Text -->
    <text x="180" y="235" font-family="system-ui, -apple-system, sans-serif" font-size="64" font-weight="700" fill="#171717">Harvest</text>
    <text x="180" y="235" font-family="system-ui, -apple-system, sans-serif" font-size="64" font-weight="700" fill="#171717" dx="245"> MCP</text>
    <text x="180" y="290" font-family="system-ui, -apple-system, sans-serif" font-size="28" fill="#525252">Connect Harvest to any MCP client</text>
    <text x="80" y="420" font-family="system-ui, -apple-system, sans-serif" font-size="20" fill="#737373">Time Tracking  •  Analytics  •  Invoices  •  Smart Search</text>
    <text x="80" y="460" font-family="system-ui, -apple-system, sans-serif" font-size="18" fill="#A3A3A3">harvest-mcp.southleft.com</text>
  </svg>`;

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

/**
 * Helper to get base URL from request
 */
function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * OAuth Protected Resource Metadata (RFC 9728)
 * Claude Desktop fetches this to discover the authorization server
 */
app.get('/.well-known/oauth-protected-resource', (c) => {
  const baseUrl = getBaseUrl(c.req.raw);

  return c.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/southleft/harvest-mcp',
  });
});

/**
 * OAuth Authorization Server Metadata (RFC 8414)
 * Claude Desktop fetches this to get OAuth endpoints
 */
app.get('/.well-known/oauth-authorization-server', (c) => {
  const baseUrl = getBaseUrl(c.req.raw);

  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: 'https://github.com/southleft/harvest-mcp',
  });
});

/**
 * Dynamic Client Registration (RFC 7591)
 * For clients that need to register dynamically
 */
app.post('/register', async (c) => {
  // For simplicity, we accept any registration and return a client_id
  // In production, you might want to validate and store these
  const body = await c.req.json().catch(() => ({}));
  const clientId = `mcp-client-${crypto.randomUUID()}`;

  return c.json({
    client_id: clientId,
    client_name: body.client_name || 'MCP Client',
    redirect_uris: body.redirect_uris || [],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
});

/**
 * OAuth Authorization Endpoint
 * Redirects to Harvest OAuth, storing the client's callback for later
 */
app.get('/authorize', async (c) => {
  const env = c.env;
  const config = loadWorkersConfig(env, c.req.raw);
  const sessionStore = new KVSessionStore(env.SESSIONS, config.security.sessionTtlHours);

  const {
    client_id,
    redirect_uri,
    response_type,
    state,
    code_challenge,
    code_challenge_method,
  } = c.req.query();

  // Validate required params
  if (response_type !== 'code') {
    return c.json({ error: 'unsupported_response_type' }, 400);
  }

  if (!redirect_uri) {
    return c.json({ error: 'invalid_request', error_description: 'redirect_uri required' }, 400);
  }

  // Create a session to track this OAuth flow
  const sessionId = crypto.randomUUID();
  const authSession: Session = {
    id: sessionId,
    harvestAccessToken: '',
    harvestRefreshToken: '',
    harvestAccountId: '',
    tokenExpiresAt: new Date(0),
    userId: 0,
    userEmail: '',
    createdAt: new Date(),
    lastAccessedAt: new Date(),
    // Store client's OAuth params for the callback
    pendingOAuthState: JSON.stringify({
      clientRedirectUri: redirect_uri,
      clientState: state,
      clientId: client_id,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
    }),
  };

  await sessionStore.set(sessionId, authSession);

  // Generate state for Harvest OAuth that encodes our session
  const harvestState = HarvestOAuth.generateState(sessionId);

  // Redirect to Harvest OAuth
  const oauth = new HarvestOAuth(config.harvest);
  const harvestAuthUrl = oauth.getAuthorizationUrl(harvestState);

  return c.redirect(harvestAuthUrl);
});

/**
 * OAuth Token Endpoint
 * Exchanges authorization codes for access tokens
 */
app.post('/token', async (c) => {
  const env = c.env;
  const config = loadWorkersConfig(env, c.req.raw);
  const sessionStore = new KVSessionStore(env.SESSIONS, config.security.sessionTtlHours);

  // Parse form data
  const contentType = c.req.header('content-type') || '';
  let params: Record<string, string> = {};

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await c.req.text();
    params = Object.fromEntries(new URLSearchParams(text));
  } else if (contentType.includes('application/json')) {
    params = await c.req.json();
  }

  const { grant_type, code, refresh_token, code_verifier } = params;

  if (grant_type === 'authorization_code') {
    if (!code) {
      return c.json({ error: 'invalid_request', error_description: 'code required' }, 400);
    }

    // The code IS the session ID (we set it that way in callback)
    const session = await sessionStore.get(code);
    if (!session || !session.harvestAccessToken) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired code' }, 400);
    }

    // TODO: Verify code_verifier against stored code_challenge if PKCE was used

    // Generate an access token (the session ID serves as our token)
    const accessToken = session.id;

    // Return tokens
    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: config.security.sessionTtlHours * 3600,
      refresh_token: session.harvestRefreshToken ? session.id : undefined,
    });
  } else if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      return c.json({ error: 'invalid_request', error_description: 'refresh_token required' }, 400);
    }

    // The refresh token IS the session ID
    const session = await sessionStore.get(refresh_token);
    if (!session || !session.harvestRefreshToken) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, 400);
    }

    // Refresh the Harvest token
    try {
      const oauth = new HarvestOAuth(config.harvest);
      const tokens = await oauth.refreshToken(session.harvestRefreshToken);

      // Update session
      session.harvestAccessToken = tokens.access_token;
      session.harvestRefreshToken = tokens.refresh_token;
      session.tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
      await sessionStore.set(session.id, session);

      return c.json({
        access_token: session.id,
        token_type: 'Bearer',
        expires_in: config.security.sessionTtlHours * 3600,
        refresh_token: session.id,
      });
    } catch (err) {
      console.error('Token refresh error:', err);
      return c.json({ error: 'invalid_grant', error_description: 'Failed to refresh token' }, 400);
    }
  }

  return c.json({ error: 'unsupported_grant_type' }, 400);
});

/**
 * Create a session object - either from KV or a new empty one
 */
async function getOrCreateSession(
  sessionStore: KVSessionStore,
  harvestSessionId: string | undefined
): Promise<Session> {
  // If we have a harvest session ID, try to load it
  if (harvestSessionId) {
    const existingSession = await sessionStore.get(harvestSessionId);
    if (existingSession) {
      await sessionStore.touch(harvestSessionId);
      return existingSession;
    }
  }

  // Create a new session
  const newId = crypto.randomUUID();
  const newSession: Session = {
    id: newId,
    harvestAccessToken: '',
    harvestRefreshToken: '',
    harvestAccountId: '',
    tokenExpiresAt: new Date(0),
    userId: 0,
    userEmail: '',
    createdAt: new Date(),
    lastAccessedAt: new Date(),
  };

  await sessionStore.set(newId, newSession);
  return newSession;
}

/**
 * Helper to create initialize request for pre-warming
 */
function createInitializeRequest(sessionId: string): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'harvest-mcp-prewarm', version: '1.0' },
      },
      id: `prewarm-${sessionId}`,
    }),
  });
}

/**
 * Parse JSON-RPC method from request body
 */
async function parseMethod(request: Request): Promise<{ method: string; body: string } | null> {
  try {
    const body = await request.text();
    const parsed = JSON.parse(body);
    return { method: parsed.method || '', body };
  } catch {
    return null;
  }
}

/**
 * MCP Endpoint - handles all MCP protocol requests
 * Uses stateless mode with auto-initialization for returning sessions
 * Supports OAuth Bearer token authentication for Claude Desktop Connectors
 */
app.all('/mcp', async (c) => {
  const env = c.env;
  const request = c.req.raw;
  const config = loadWorkersConfig(env, request);
  const sessionStore = new KVSessionStore(env.SESSIONS, config.security.sessionTtlHours);
  const baseUrl = getBaseUrl(request);

  // Check for Authorization: Bearer token (OAuth flow from Claude Desktop)
  const authHeader = c.req.header('Authorization');
  let sessionId: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    sessionId = authHeader.slice(7); // Extract token after "Bearer "
  } else {
    // Fallback to legacy headers
    sessionId = c.req.header('x-harvest-session') || c.req.header('mcp-session-id');
  }

  // If we have a session ID, try to load it
  let session: Session | null = null;
  if (sessionId) {
    session = await sessionStore.get(sessionId);
    if (session) {
      await sessionStore.touch(sessionId);
    }
  }

  // If no valid session with tokens, return 401 with OAuth metadata
  // This tells Claude Desktop to initiate the OAuth flow per MCP Authorization spec
  if (!session || !session.harvestAccessToken) {
    // Return 401 with WWW-Authenticate header pointing to protected resource metadata (RFC 9728)
    // Format: Bearer resource_metadata="<url>"
    const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Authorization required. Please authenticate with Harvest.',
      },
      id: null,
    }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
        'Access-Control-Expose-Headers': 'WWW-Authenticate',
      },
    });
  }

  // Parse the incoming request to determine the method
  const parsed = await parseMethod(request.clone());
  const isInitRequest = parsed?.method === 'initialize';

  // Create stateless transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => session.id,
    enableJsonResponse: true,
  });

  // Create MCP server for this request
  // Icons must be from same origin per MCP security requirements
  const server = new McpServer({
    name: 'Harvest',
    version: '0.1.0',
    description: 'Time tracking and project management via Harvest API',
    icons: [
      {
        src: `${baseUrl}/icon.png`,
        mimeType: 'image/png',
        sizes: ['180x180'],
      },
    ],
  });

  // Register all Harvest tools with the current session
  registerTools(server, session, sessionStore, config);

  // Connect server to transport
  await server.connect(transport);

  // If this is NOT an initialize request but the session was previously initialized,
  // pre-warm the server with a synthetic initialize request
  const wasInitialized = await sessionStore.isMcpInitialized(session.id);

  if (!isInitRequest && wasInitialized) {
    const initRequest = createInitializeRequest(session.id);
    await transport.handleRequest(initRequest);
  }

  // Handle the actual request - ensure mcp-session-id header is set
  const actualHeaders = new Headers(request.headers);
  actualHeaders.set('mcp-session-id', session.id);

  const actualRequest = new Request(request.url, {
    method: request.method,
    headers: actualHeaders,
    body: parsed?.body,
  });

  const response = await transport.handleRequest(actualRequest);

  // If this was an initialize request, mark session as initialized
  if (isInitRequest && response.status === 200) {
    await sessionStore.setMcpInitialized(session.id, true);
  }

  // Add harvest session ID to response headers for client to track
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('x-harvest-session', session.id);

  return newResponse;
});

/**
 * OAuth Callback - handles Harvest OAuth redirect
 * If this was initiated via /authorize, redirects back to client's redirect_uri
 * Otherwise shows a success page (for legacy in-chat auth flow)
 */
app.get('/callback', async (c) => {
  const env = c.env;
  const config = loadWorkersConfig(env, c.req.raw);
  const sessionStore = new KVSessionStore(env.SESSIONS, config.security.sessionTtlHours);
  const oauth = new HarvestOAuth(config.harvest);

  const { code, state, error } = c.req.query();

  if (error) {
    return c.text(`OAuth error: ${error}`, 400);
  }

  if (!code || !state) {
    return c.text('Missing code or state parameter', 400);
  }

  // Parse state to get session ID
  const parsedState = HarvestOAuth.parseState(state);
  if (!parsedState) {
    return c.text('Invalid state parameter', 400);
  }

  // Get session
  const session = await sessionStore.get(parsedState.sessionId);
  if (!session) {
    return c.text('Session not found', 400);
  }

  try {
    // Exchange code for tokens
    const tokens = await oauth.exchangeCode(code);

    // Get user accounts
    const accountsResponse = await oauth.getAccounts(tokens.access_token);

    // Find first Harvest account
    const harvestAccount = accountsResponse.accounts.find((a) => a.product === 'harvest');
    if (!harvestAccount) {
      return c.text('No Harvest account found', 400);
    }

    // Update session with tokens
    session.harvestAccessToken = tokens.access_token;
    session.harvestRefreshToken = tokens.refresh_token;
    session.harvestAccountId = String(harvestAccount.id);
    session.tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    session.userId = accountsResponse.user.id;
    session.userEmail = accountsResponse.user.email;

    // Parse the pending OAuth state to see if we need to redirect to client
    const pendingOAuth = session.pendingOAuthState
      ? JSON.parse(session.pendingOAuthState)
      : null;

    // Clear the pending state
    session.pendingOAuthState = undefined;
    await sessionStore.set(session.id, session);

    console.log(`OAuth completed for session ${session.id}, user: ${session.userEmail}`);

    // If this was initiated via /authorize, redirect back to the client
    if (pendingOAuth?.clientRedirectUri) {
      const redirectUrl = new URL(pendingOAuth.clientRedirectUri);
      // Use the session ID as the authorization code
      redirectUrl.searchParams.set('code', session.id);
      if (pendingOAuth.clientState) {
        redirectUrl.searchParams.set('state', pendingOAuth.clientState);
      }

      console.log(`Redirecting to client: ${redirectUrl.toString()}`);
      return c.redirect(redirectUrl.toString());
    }

    // Legacy flow: show success page with session ID for manual copy
    return c.html(`
      <!DOCTYPE html>
      <html>
        <head><title>Harvest MCP - Authorized</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1>Authorization Successful</h1>
          <p>You have successfully connected your Harvest account.</p>
          <p>Account: <strong>${harvestAccount.name}</strong></p>
          <p>User: <strong>${accountsResponse.user.email}</strong></p>
          <p style="margin-top: 20px; padding: 10px; background: #f0f0f0; border-radius: 4px;">
            Session ID: <code>${session.id}</code>
          </p>
          <p>You can now close this window and return to your AI assistant.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err);
    return c.text('Failed to complete authorization', 500);
  }
});

/**
 * Export the fetch handler for Cloudflare Workers
 */
export default {
  fetch: app.fetch,
};
