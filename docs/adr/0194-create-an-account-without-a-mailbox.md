# Create an Account without a mailbox

An Account is created by signing in with Google's identity scopes alone and pressing one button, with no name to confirm and no permission to grant; its Automation Inbox is connected later, by any member, from the 接続 screen. Until then its runs hold no Google grant and are offered no mail, calendar, Drive, or Meet tool, and 毎朝のメール処理 waits as a draft that connecting the Inbox turns on.

Creation used to demand the whole Gmail, Calendar, Drive, and Meet grant up front, which made the Google account the Account's identity and Inbox at once, put the unverified-app warning in front of everyone who only wanted to try the product, and made OrangeAgent a mail service before it could be anything else. We chose to let an Account be a plain AI tool first, accepting that an Account may exist with nothing to read, that every run must ask whether a mailbox is connected, and that anyone with a Google account can now create an Account and its D1 database without the grant's friction.

The mailbox a member connects is the Account's, not the member's: it need not be the member's own Google account, and connecting it opens no session for it. A grant refused while connecting is revoked only when no Account's Inbox is that Google account, because Google revokes a person's whole grant to the OAuth client at once.
