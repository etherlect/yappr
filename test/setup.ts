// Imported first by every test file (`import "./setup.js"`) so the engine's
// env-validated config (src/config.ts) and SQLite layer (src/db.ts) load against a
// throwaway in-memory database and dummy credentials — never a real .env, the
// network, or your yappr.db. ESM evaluates imports in order, so as long as this is
// the first import in a test file the env is set before any engine module loads.
// dotenv (pulled in by those modules) won't override a var already set here.

process.env.DB_PATH = ":memory:";
process.env.AGENT_HANDLE ||= "testbot";
process.env.BANKR_API_KEY ||= "test-key";
process.env.TWITTER_AUTH_TOKEN ||= "test-auth";
process.env.TWITTER_CT0 ||= "test-ct0";
process.env.TOKEN_ADDRESS ||= "0x0000000000000000000000000000000000000000";
