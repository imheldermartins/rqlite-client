import { Table as Entity, Column as Field, Json, Index } from '@cubs/rqlite-client/schema';
import { Base } from './Base.schema.js';
const TABLE = 'documents';
@Entity(TABLE)
@Index('documents_title', ['title'])
export class Document extends Base {
  @Field() title!: string | null;
  @Field() status!: 'draft' | 'ready';
  @Field() @Json() data!: Record<string, unknown> | null;
}
@Entity('folders')
export class Folder extends Base {
  @Field() label!: string;
}
