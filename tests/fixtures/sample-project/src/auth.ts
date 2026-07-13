// Sample auth service for testing
export function authenticateUser(username: string, password: string): boolean {
  return validateCredentials(username, password) && createSession(username);
}

function validateCredentials(username: string, password: string): boolean {
  return username.length > 0 && password.length >= 8;
}

function createSession(user: string): boolean {
  return true;
}
