/**
 * Set a dashboard account's password from the command line (creates the account as an
 * admin if it does not exist). For a forgotten admin password - no need to delete the database.
 *
 *   npm run user:password -w server -- admin "new password"
 *
 * The user is signed out everywhere. Works while the server is running.
 */
import { hashPassword } from "../src/auth";
import { loadDotEnv, loadSettings } from "../src/config";
import { Store } from "../src/store";

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('usage: npm run user:password -w server -- <username> "<password>"');
  process.exit(2);
}
loadDotEnv();
const store = new Store(loadSettings().dataDir);
const hash = await hashPassword(password);
const existing = store.findUser(username);
if (existing) {
  store.updateUser(existing.id, { passwordHash: hash, disabled: false });
  store.deleteAuthSessionsForUser(existing.id);
  console.log(`password changed for ${existing.username} (${existing.role}); signed out everywhere`);
} else {
  store.createUser(username, hash, "admin");
  console.log(`created admin ${username}`);
}
store.close();
