import { MappedSuperclass, Column, PrimaryKey, Generated, Default, CreatedAt, sql } from '@cubs/rqlite-client/schema';
@MappedSuperclass()
export abstract class Identity {
  @Column() @PrimaryKey() @Generated('ulid') id!: string;
}
@MappedSuperclass()
export abstract class Base extends Identity {
  @Column() @CreatedAt() @Default(sql.currentTimestamp()) created_at!: string;
}
