import { config } from '../config';
import { openDatabase, runMigrations } from './client';

const { db, sqlite } = openDatabase(config.databasePath);
runMigrations(db);
sqlite.close();
console.log(`Migrations applied to ${config.databasePath}`);
