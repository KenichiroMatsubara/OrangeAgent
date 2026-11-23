import { describe, expect, it } from 'vitest';

import { GOOGLE_SCOPES, googleAuthorizationUrl, grantsDrafts, grantsDrive, grantsMeet, grantsTasks, hasCompleteGoogleGrant, missingGoogleScopes } from './google';

describe('Automation Inbox Google grant', () => {
  it('requires the entire Automation Inbox scope set', () => {
    expect(hasCompleteGoogleGrant(GOOGLE_SCOPES)).toBe(true);
    expect(hasCompleteGoogleGrant(GOOGLE_SCOPES.filter((scope) => scope !== 'https://www.googleapis.com/auth/gmail.readonly'))).toBe(false);
    expect(missingGoogleScopes(['openid', 'email', 'profile'])).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/meetings.space.readonly',
      'https://www.googleapis.com/auth/meetings.space.settings',
      'https://www.googleapis.com/auth/tasks',
    ]);
  });

  it('accepts Google\'s canonical OpenID scope names', () => {
    expect(hasCompleteGoogleGrant([
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/meetings.space.readonly',
      'https://www.googleapis.com/auth/meetings.space.settings',
      'https://www.googleapis.com/auth/tasks',
    ])).toBe(true);
  });

  it('reaches the Drive only under a grant that holds the whole Drive, which one given before it reached the Drive lacks', () => {
    expect(grantsDrive(GOOGLE_SCOPES)).toBe(true);
    expect(grantsDrive(GOOGLE_SCOPES.filter((scope) => scope !== 'https://www.googleapis.com/auth/drive'))).toBe(false);
  });

  it('reads Meet transcripts only under a grant that holds both Meet scopes, which one given before Meet was reached lacks', () => {
    expect(grantsMeet(GOOGLE_SCOPES)).toBe(true);
    expect(grantsMeet(GOOGLE_SCOPES.filter((scope) => scope !== 'https://www.googleapis.com/auth/meetings.space.settings'))).toBe(false);
  });

  it('keeps Tasks in Google Tasks only under a grant that holds its scope, which one given before Tasks moved there lacks', () => {
    expect(grantsTasks(GOOGLE_SCOPES)).toBe(true);
    expect(grantsTasks(GOOGLE_SCOPES.filter((scope) => scope !== 'https://www.googleapis.com/auth/tasks'))).toBe(false);
  });

  it('saves drafts only under a grant that holds the whole mailbox, which one given before drafts existed lacks', () => {
    expect(grantsDrafts(GOOGLE_SCOPES)).toBe(true);
    expect(grantsDrafts(GOOGLE_SCOPES.filter((scope) => scope !== 'https://mail.google.com/'))).toBe(false);
  });

  it('requires Gmail sending and Drive publication capabilities for an Automation Inbox', () => {
    expect(hasCompleteGoogleGrant([
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events.owned',
    ])).toBe(false);
    expect(missingGoogleScopes([
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events.owned',
    ])).toEqual([
      'https://www.googleapis.com/auth/gmail.send',
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/meetings.space.readonly',
      'https://www.googleapis.com/auth/meetings.space.settings',
      'https://www.googleapis.com/auth/tasks',
    ]);
  });

  it('always sends OAuth through PKCE and requests offline consent', () => {
    const url = new URL(googleAuthorizationUrl({
      clientId: 'client-id',
      redirectUri: 'https://example.com/oauth/google/callback',
      state: 'opaque-state',
      challenge: 'pkce-challenge',
    }));

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.readonly');
  });

  it('uses an online identity-only flow for ordinary login', () => {
    const url = new URL(googleAuthorizationUrl({
      clientId: 'client-id',
      redirectUri: 'https://example.com/oauth/google/callback',
      state: 'opaque-state',
      challenge: 'pkce-challenge',
      scopes: ['openid', 'email', 'profile'],
      accessType: 'online',
      prompt: 'select_account',
    }));

    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

});
