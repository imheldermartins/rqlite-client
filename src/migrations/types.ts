import type { Statement } from '../client/index.js';
import type { SchemaDocument } from '../schema/types.js';
export interface Migration {
  formatVersion: 1; id: string; description: string; parentId: string | null;
  beforeSchemaHash: string; afterSchemaHash: string; checksum: string;
  requiredCapabilities: string[]; risk: 'safe' | 'manual' | 'destructive'; state: 'draft' | 'ready';
  up: Statement[]; down?: Statement[];
  dataOnly?: boolean;
  verifiedCatalog?: string;
}
export interface JournalEntry { id: string; file: string; snapshot: string; checksum: string }
export interface Journal {
  formatVersion: 1; baseline: SchemaDocument; baselineCatalog: string;
  legacy: {id: string; checksum: string}[]; entries: JournalEntry[];
}
