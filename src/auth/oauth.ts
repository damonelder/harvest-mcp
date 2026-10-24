/**
 * Harvest OAuth2 client implementation
 */

import type { Config } from '../config.js';
import type { TokenResponse, HarvestAccountsResponse } from '../session/types.js';

export class HarvestOAuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'HarvestOAuthError';
  }

  /** True when Harvest rejected the grant itself (re-authorization needed), not a transient failure. */
  get isInvalidGrant(): boolean {
    return this.status === 400 || this.status === 401;
  }
}

export class HarvestOAuth {
  private config: Config['harvest'];

  constructor(config: Config['harvest']) {
    this.config = config;
  }

  /**
   * Generate the authorization URL for Harvest OAuth
   * @param state - State parameter for CSRF protection (should include session ID)
   */
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: this.config.redirectUri,
      state,
    });

    return `${this.config.authBaseUrl}/oauth2/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access and refresh tokens
   */
  async exchangeCode(code: string): Promise<TokenResponse> {
    const response = await fetch(`${this.config.authBaseUrl}/api/v2/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'SpotlightHarvestMCP/0.2.0',
      },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code: ${response.status} - ${error}`);
    }

    return response.json() as Promise<TokenResponse>;
  }

  /**
   * Refresh an expired access token
   */
  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    const response = await fetch(`${this.config.authBaseUrl}/api/v2/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'SpotlightHarvestMCP/0.2.0',
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new HarvestOAuthError(`Failed to refresh Harvest token: HTTP ${response.status}`, response.status);
    }

    return response.json() as Promise<TokenResponse>;
  }

  /**
   * Get list of Harvest accounts accessible with the token
   */
  async getAccounts(accessToken: string): Promise<HarvestAccountsResponse> {
    const response = await fetch(`${this.config.authBaseUrl}/api/v2/accounts`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'SpotlightHarvestMCP/0.2.0',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get accounts: ${response.status} - ${error}`);
    }

    return response.json() as Promise<HarvestAccountsResponse>;
  }

  /**
   * Generate a secure state parameter that encodes the session ID
   */
  static generateState(sessionId: string): string {
    // In production, you might want to encrypt this
    const random = crypto.randomUUID();
    return Buffer.from(JSON.stringify({ sessionId, random })).toString('base64url');
  }

  /**
   * Parse and validate the state parameter
   */
  static parseState(state: string): { sessionId: string } | null {
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
      if (typeof decoded.sessionId === 'string') {
        return { sessionId: decoded.sessionId };
      }
      return null;
    } catch {
      return null;
    }
  }
}
