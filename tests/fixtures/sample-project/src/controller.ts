import { authenticateUser } from "./auth.ts";

export class UserController {
  login(username: string, password: string): string {
    if (authenticateUser(username, password)) {
      return `Welcome, ${username}!`;
    }
    return "Login failed";
  }
}
