import type {SQLBuilder} from './sql-builder.js';
import type {LookupsConfig,LookupValues,SqlStatement,RqliteStatement} from './types.js';
import type {SuccessResult} from './response-types.js';
export interface DeleteSolution<T>{scopeRead(lookup?:LookupsConfig<T>):LookupsConfig<T>|undefined;scopeLookup(lookup:LookupValues<T>):LookupValues<T>;statement(sql:SQLBuilder<T>,lookup:LookupValues<T>):SqlStatement;}
export interface ModelOptions<T>{jsonColumns?:(keyof T)[];deleteSolution?:DeleteSolution<T>;}
export interface MutationOptions{before?:readonly SqlStatement[];after?:readonly RqliteStatement[];}
export interface ModelExecutor{
 query<T>(statement:string|SqlStatement,endpoint?:'query'|'execute'|'request'):Promise<SuccessResult<T>|null>;
 mutate(statement:SqlStatement,options?:MutationOptions):Promise<boolean>;
 mutateAndRead<T>(statement:SqlStatement,read:SqlStatement,operation:'Create'|'Update',options?:MutationOptions):Promise<T|null>;
}
