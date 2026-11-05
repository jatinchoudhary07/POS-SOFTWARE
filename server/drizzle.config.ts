import { defineConfig } from 'drizzle-kit';

// Used only by `npm run db:generate` to turn src/db/schema.ts into SQL migration files.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
