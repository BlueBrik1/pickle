export interface Session {
  userId: string;
  token: string;
}

let current: Session | undefined;

export function setSession(session: Session | undefined) {
  current = session;
}

export function sessionToken(): string {
  if (!current) throw new Error('Sign in before checking out.');
  return current.token;
}
