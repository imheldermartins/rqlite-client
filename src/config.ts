import type { SchemaDocument } from './schema/types.js';
export interface RqliteConfig {
  schemas?: string[];
  output?: string;
  migrations: string;
  client?: string;
  build?: {config: string; migrations: string; client: string};
  opaqueObjects?: string;
  environments: Record<string,{url?:string;urlEnv?:string;hostEnv?:string;portEnv?:string;host?:string;port?:string;development:boolean}>;
}
export const defineConfig = (config: RqliteConfig): RqliteConfig => config;
export const emptySchema = (): SchemaDocument => ({formatVersion:1,tables:[],opaque:[]});
