/**
 * Checks for the schema catalog (lib/analysis/db/) and the schema
 * comparison: one fixture per v1 source — a Prisma schema with migrations,
 * Drizzle tables with a journal, TypeORM entities with a migration, a
 * Django app with migrations, SQLAlchemy models with an Alembic chain, a
 * golang-migrate folder — merging and drift, the endpoint links (model,
 * query builder, SQL text — a literal naming an unknown table is dropped),
 * DDL in code (a `MIGRATIONS` array of template literals, a Go slice), a head
 * whose migrations produce each finding, and the review context.
 *
 *   npx tsx lib/analysis/db/smoke-test-db.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRepo } from "../graph-builder";
import { renderRelatedSections } from "../../ai/prompts";
import { reviewComponentChange } from "../../ai/review";
import { compareSchemas } from "./compare";
import { describeSchemaChange, reviewTables, tablesTouching } from "./describe";
import { parseSql, sqlTableRefs, typeNarrowing } from "./sql";
import type { Database, DbSchema, DbTable } from "./types";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const PRISMA_SCHEMA = (extra: string[] = [], head = false) =>
  lines(
    'datasource db { provider = "postgresql"\n url = env("DATABASE_URL") }',
    "",
    "model Customer {",
    "  id     Int     @id @default(autoincrement())",
    head ? "  email  String  @unique @db.VarChar(50)" : "  email  String  @unique",
    head ? '  fullName String @map("full_name")' : "  name   String",
    "  orders Order[]",
    "}",
    "",
    "model Order {",
    "  id         Int      @id @default(autoincrement())",
    ...(head ? ["  channel    String"] : ["  total      Decimal"]),
    "  status     Status   @default(PENDING)",
    '  customerId Int      @map("customer_id")',
    "  customer   Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)",
    "  note       String?",
    ...extra,
    '  @@map("orders")',
    "}",
    "",
    "enum Status {",
    "  PENDING",
    "  PAID",
    "}",
  );

/** This repo's own pattern: an array of template literals run in order by `db.exec(MIGRATIONS[v])`. */
const IN_CODE_SCHEMA = (head = false) =>
  lines(
    'import { DatabaseSync } from "node:sqlite";',
    "const T = 'x';",
    "const MIGRATIONS: string[] = [",
    "  `",
    "  -- the first version",
    "  CREATE TABLE items (",
    "    id   TEXT PRIMARY KEY,",
    "    name TEXT NOT NULL,",
    "    legacy TEXT",
    "  );",
    "  CREATE INDEX items_name ON items (name);",
    "  `,",
    head ? "  `ALTER TABLE items ADD COLUMN price INTEGER NOT NULL DEFAULT 0;`," : "  `ALTER TABLE items ADD COLUMN price INTEGER;`,",
    "  `CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT); INSERT INTO ${T} VALUES (1);`,",
    ...(head ? ["  `ALTER TABLE items DROP COLUMN legacy;`,"] : []),
    "];",
    "export function migrate(db: DatabaseSync, v: number) {",
    "  db.exec(MIGRATIONS[v]);",
    "  db.exec(`PRAGMA user_version = ${v + 1}`);",
    "}",
  );

const BASE: Record<string, string> = {
  // --- SQL in code: a migrations array, a query file using it, a smoke test's throwaway DDL, a Go slice ---
  "appdb/src/db/schema.ts": IN_CODE_SCHEMA(),
  "appdb/src/db/items.ts": lines("export function getItem(db: any, id: string) {", '  return db.prepare("SELECT id, name, price FROM items WHERE id = ?").get(id);', "}"),
  "appdb/src/db/smoke-test-items.ts": lines("export function setup(db: any) {", '  db.exec("CREATE TABLE scratch (id INTEGER PRIMARY KEY)");', "}"),
  "gosvc/store.go": lines("package main", "", "var schema = []string{", "	`CREATE TABLE gadgets (id INTEGER PRIMARY KEY)`,", "	`ALTER TABLE gadgets ADD COLUMN name TEXT`,", "}"),
  // A startup runner of tagged templates (Neon / @vercel/postgres / postgres.js), one createX() per table, idempotent ALTERs after.
  "neon/migrations/migrate.ts": lines(
    'import { sql } from "@/actions/db/db_actions";',
    "export async function migrate() {",
    "  await createMembers();",
    "  await createMemos();",
    "}",
    "async function createMembers() {",
    "  await sql`",
    "    CREATE TABLE IF NOT EXISTS members (",
    "      id SERIAL PRIMARY KEY,",
    "      username TEXT NOT NULL UNIQUE",
    "    )",
    "  `;",
    "  await sql`INSERT INTO members (username) VALUES (${'admin'}) ON CONFLICT DO NOTHING`;",
    "  await sql`ALTER TABLE members ADD COLUMN IF NOT EXISTS invite_token TEXT`;",
    "}",
    "async function createMemos() {",
    "  await sql`CREATE TABLE IF NOT EXISTS memos (id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), body TEXT)`;",
    "  await sql`CREATE INDEX IF NOT EXISTS memos_member_idx ON memos (member_id)`;",
    "}",
  ),
  "neon/actions/db/db_actions.ts": lines('import { neon } from "@neondatabase/serverless";', "export const sql = neon(process.env.DATABASE_URL!);"),
  "neon/actions/memos.ts": lines('import { sql } from "./db/db_actions";', "export async function memosOf(id: number) {", "  return sql`SELECT id, body FROM memos WHERE member_id = ${id}`;", "}"),
  // Drizzle's and Kysely's sql tag running DDL, and Python cursor.execute — one CREATE TABLE IF NOT EXISTS per file.
  "kyapp/src/setup.ts": lines(
    'import { sql } from "drizzle-orm";',
    "export async function setup(db: any) {",
    "  await db.execute(sql`CREATE TABLE IF NOT EXISTS widgets (id serial PRIMARY KEY, label text NOT NULL)`);",
    "  await sql`ALTER TABLE widgets ADD COLUMN IF NOT EXISTS color text`.execute(db);",
    "}",
  ),
  "pyapp/store.py": lines("import sqlite3", "def ensure(cur):", '    cur.execute("""CREATE TABLE IF NOT EXISTS gizmos (id INTEGER PRIMARY KEY, name TEXT)""")'),

  // --- Prisma: schema + migrations, an endpoint through a Prisma delegate, SQL text naming an unknown table ---
  "package.json": JSON.stringify({ name: "fixture", dependencies: { next: "15.0.0" } }),
  "prisma/schema.prisma": PRISMA_SCHEMA(),
  "prisma/migrations/migration_lock.toml": 'provider = "postgresql"\n',
  "prisma/migrations/20240101000000_init/migration.sql": lines(
    "-- CreateEnum",
    "CREATE TYPE \"Status\" AS ENUM ('PENDING', 'PAID');",
    "",
    "-- CreateTable",
    'CREATE TABLE "Customer" (',
    '    "id" SERIAL NOT NULL,',
    '    "email" TEXT NOT NULL,',
    '    "name" TEXT NOT NULL,',
    '    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")',
    ");",
    "",
    'CREATE TABLE "orders" (',
    '    "id" SERIAL NOT NULL,',
    '    "total" DECIMAL(65,30) NOT NULL,',
    "    \"status\" \"Status\" NOT NULL DEFAULT 'PENDING',",
    '    "customer_id" INTEGER NOT NULL,',
    '    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")',
    ");",
    "",
    'CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");',
    "",
    'ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  ),
  "src/orders.ts": lines(
    'import { prisma } from "./prisma";',
    "export async function listOrders() {",
    "  return prisma.order.findMany({ where: { status: 'PAID' } });",
    "}",
    "export async function createOrder(total: number, customerId: number) {",
    "  return prisma.order.create({ data: { total, customerId } });",
    "}",
    "export async function report() {",
    "  return prisma.$queryRaw`SELECT o.id, c.email FROM orders o JOIN \"Customer\" c ON c.id = o.customer_id JOIN ghosts g ON g.id = o.id`;",
    "}",
  ),
  "src/prisma.ts": lines('import { PrismaClient } from "@prisma/client";', "export const prisma = new PrismaClient();"),
  "app/api/orders/route.ts": lines('import { listOrders, createOrder } from "../../../src/orders";', "export async function GET() {", "  return Response.json(await listOrders());", "}", "export async function POST() {", "  return Response.json(await createOrder(1, 1));", "}"),
  "app/api/report/route.ts": lines('import { report } from "../../../src/orders";', "export async function GET() {", "  return Response.json(await report());", "}"),

  // --- Drizzle: tables + journal; a Kysely builder string ---
  "web/src/db/schema.ts": lines(
    'import { pgTable, serial, text, integer, varchar, pgEnum, index, timestamp } from "drizzle-orm/pg-core";',
    'export const role = pgEnum("role", ["admin", "member"]);',
    'export const users = pgTable("users", {',
    '  id: serial("id").primaryKey(),',
    '  email: varchar("email", { length: 255 }).notNull().unique(),',
    '  role: role("role").default("member").notNull(),',
    '  createdAt: timestamp("created_at").defaultNow(),',
    "});",
    'export const posts = pgTable("posts", {',
    '  id: serial("id").primaryKey(),',
    '  title: text("title").notNull(),',
    '  authorId: integer("author_id").references(() => users.id, { onDelete: "cascade" }),',
    '}, (t) => ({ authorIdx: index("posts_author_idx").on(t.authorId) }));',
  ),
  "web/drizzle/0000_init.sql": lines(
    "CREATE TYPE \"public\".\"role\" AS ENUM('admin', 'member');--> statement-breakpoint",
    'CREATE TABLE IF NOT EXISTS "users" (',
    '\t"id" serial PRIMARY KEY NOT NULL,',
    '\t"email" varchar(255) NOT NULL,',
    "\t\"role\" \"role\" DEFAULT 'member' NOT NULL,",
    '\t"created_at" timestamp DEFAULT now(),',
    '\tCONSTRAINT "users_email_unique" UNIQUE("email")',
    ");",
    "--> statement-breakpoint",
    'CREATE TABLE IF NOT EXISTS "posts" (',
    '\t"id" serial PRIMARY KEY NOT NULL,',
    '\t"title" text NOT NULL,',
    '\t"author_id" integer',
    ");",
    "--> statement-breakpoint",
    'ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
    'CREATE INDEX IF NOT EXISTS "posts_author_idx" ON "posts" USING btree ("author_id");',
  ),
  "web/drizzle/meta/_journal.json": JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1700000000000, tag: "0000_init", breakpoints: true }] }),
  "web/src/feed.ts": lines(
    'import { db } from "./db/client";',
    'import { users } from "./db/schema";',
    "export async function allUsers() {",
    "  return db.select().from(users);",
    "}",
    "export async function latestPosts(k: any) {",
    '  return k.selectFrom("posts").selectAll().execute();',
    "}",
  ),
  "web/src/db/client.ts": lines("export const db: any = {};"),

  // --- TypeORM: entities + a migration class ---
  "orm/src/entity/User.ts": lines(
    'import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm";',
    'import { Photo } from "./Photo";',
    "@Entity()",
    "export class AppUser {",
    "  @PrimaryGeneratedColumn()",
    "  id: number;",
    "  @Column()",
    "  name: string;",
    "  @Column({ nullable: true })",
    "  bio: string;",
    "  @OneToMany(() => Photo, (p) => p.owner)",
    "  photos: Photo[];",
    "}",
  ),
  "orm/src/entity/Photo.ts": lines(
    'import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from "typeorm";',
    'import { AppUser } from "./User";',
    '@Entity("photo")',
    "export class Photo {",
    "  @PrimaryGeneratedColumn()",
    "  id: number;",
    '  @Column("varchar", { length: 100 })',
    "  url: string;",
    "  @ManyToOne(() => AppUser, (u) => u.photos)",
    "  owner: AppUser;",
    "}",
  ),
  "orm/src/migration/1700000000000-Init.ts": lines(
    'import { MigrationInterface, QueryRunner, Table } from "typeorm";',
    "export class Init1700000000000 implements MigrationInterface {",
    "  public async up(queryRunner: QueryRunner): Promise<void> {",
    '    await queryRunner.query(`CREATE TABLE "app_user" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "bio" character varying, CONSTRAINT "PK_1" PRIMARY KEY ("id"))`);',
    '    await queryRunner.createTable(new Table({ name: "photo", columns: [{ name: "id", type: "int", isPrimary: true, isGenerated: true }, { name: "url", type: "varchar", length: "100" }, { name: "ownerId", type: "int", isNullable: true }] }));',
    "  }",
    "  public async down(queryRunner: QueryRunner): Promise<void> {}",
    "}",
  ),

  // --- Django: models + migrations ---
  "shop/models.py": lines(
    "from django.db import models",
    "",
    "class Customer(models.Model):",
    "    email = models.EmailField(unique=True)",
    "",
    "class Order(models.Model):",
    "    customer = models.ForeignKey(Customer, on_delete=models.CASCADE)",
    "    code = models.CharField(max_length=20)",
    "    paid = models.BooleanField(default=False)",
    "",
    "class Attachment(models.Model):",
    "    pk = models.CompositePrimaryKey('type', 'id', 'filename')",
    "    type = models.TextField()",
    "    id = models.TextField()",
    "    filename = models.TextField()",
    "",
    "    class Meta:",
    "        db_table = 'attachment'",
    "        managed = False",
  ),
  "shop/migrations/__init__.py": "",
  "shop/migrations/0001_initial.py": lines(
    "from django.db import migrations, models",
    "import django.db.models.deletion",
    "",
    "class Migration(migrations.Migration):",
    "    initial = True",
    "    dependencies = []",
    "    operations = [",
    "        migrations.CreateModel(",
    "            name='Customer',",
    "            fields=[",
    "                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),",
    "                ('email', models.EmailField(max_length=254, unique=True)),",
    "            ],",
    "        ),",
    "        migrations.CreateModel(",
    "            name='Order',",
    "            fields=[",
    "                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),",
    "                ('code', models.CharField(max_length=20)),",
    "                ('customer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to='shop.customer')),",
    "            ],",
    "        ),",
    "    ]",
  ),
  "shop/views.py": lines("from .models import Order", "", "def order_list(request):", "    return list(Order.objects.filter(paid=True))"),

  // --- SQLAlchemy + Alembic ---
  "svc/app/models.py": lines(
    "from sqlalchemy import Column, Integer, String, ForeignKey",
    "from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column",
    "",
    "class Base(DeclarativeBase):",
    "    pass",
    "",
    "class Item(Base):",
    '    __tablename__ = "items"',
    "    id = Column(Integer, primary_key=True)",
    "    name: Mapped[str] = mapped_column(String(50))",
    "    price: Mapped[float | None]",
  ),
  "svc/app/queries.py": lines(
    "from sqlalchemy import text, table",
    "def names(session):",
    '    return session.execute(text("SELECT name FROM items WHERE id = :id"))',
    "def raw_items():",
    '    return table("items")',
  ),
  "svc/alembic/versions/a1_init.py": lines(
    'revision = "a1"',
    "down_revision = None",
    "from alembic import op",
    "import sqlalchemy as sa",
    "def upgrade():",
    '    op.create_table("items", sa.Column("id", sa.Integer(), nullable=False), sa.Column("name", sa.String(length=50), nullable=True), sa.PrimaryKeyConstraint("id"))',
  ),
  "svc/alembic/versions/a2_price.py": lines(
    'revision = "a2"',
    'down_revision = "a1"',
    "from alembic import op",
    "import sqlalchemy as sa",
    "def upgrade():",
    '    op.add_column("items", sa.Column("price", sa.Numeric(10, 2), nullable=True))',
  ),

  // --- golang-migrate ---
  "gosvc/migrations/000001_create_users.up.sql": "CREATE TABLE accounts (id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL);\nCREATE TABLE legacy (id INT);\n",
  "gosvc/migrations/000001_create_users.down.sql": "DROP TABLE accounts;\n",
  "gosvc/migrations/000002_add_age.up.sql": "ALTER TABLE accounts ADD COLUMN age INT;\n",
  "gosvc/main.go": lines("package main", "", "func load(db *sql.DB) {", '\tdb.Query("SELECT id, email FROM accounts WHERE age > $1", 18)', "}"),
};

function headTree(): Record<string, string> {
  return {
    ...BASE,
    "prisma/schema.prisma": PRISMA_SCHEMA(["  coupon     String?"], true),
    "prisma/migrations/20240201000000_more/migration.sql": lines(
      'ALTER TABLE "orders" ADD COLUMN "channel" TEXT NOT NULL;',
      'ALTER TABLE "orders" DROP COLUMN "total";',
      'ALTER TABLE "Customer" ALTER COLUMN "email" SET DATA TYPE VARCHAR(50);',
      'ALTER TABLE "Customer" RENAME COLUMN "name" TO "full_name";',
      'CREATE INDEX "orders_status_idx" ON "orders"("status");',
      "ALTER TYPE \"Status\" ADD VALUE 'REFUNDED';",
      'CREATE TABLE "Refund" ("id" SERIAL NOT NULL, "order_id" INTEGER NOT NULL, CONSTRAINT "Refund_pkey" PRIMARY KEY ("id"));',
      'ALTER TABLE "Refund" ADD CONSTRAINT "Refund_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
    ),
    "appdb/src/db/schema.ts": IN_CODE_SCHEMA(true),
    "gosvc/migrations/000003_rename.up.sql": "ALTER TABLE accounts RENAME TO members;\nDROP TABLE legacy;\n",
  };
}

const findTable = (schema: DbSchema, db: string, name: string): DbTable | undefined =>
  schema.databases.find((d) => d.id === db)?.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
const dbOf = (schema: DbSchema, id: string): Database | undefined => schema.databases.find((d) => d.id === id);

async function main(): Promise<void> {
  console.log("SQL reader");
  const ops = parseSql(lines("BEGIN;", "CREATE TABLE IF NOT EXISTS public.t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, n numeric(10, 2) DEFAULT 0, tags text[] NOT NULL, CHECK (n > 0));", "DO $$ BEGIN RAISE NOTICE 'x;y'; END $$;", "ALTER TABLE ONLY t ADD COLUMN IF NOT EXISTS x int, DROP COLUMN y;", "CREATE UNIQUE INDEX CONCURRENTLY i ON t USING btree (lower(n), id) WHERE id > 0;", "COMMIT;"));
  check("CREATE TABLE with identity, numeric, array, check", ops[0]?.op === "createTable" && ops[0].columns.length === 3 && ops[0].columns[0].generated === "identity" && ops[0].columns[1].type === "numeric(10,2)" && ops[0].columns[2].type === "text[]" && ops[0].checks.length === 1, JSON.stringify(ops[0]));
  check("a DO block is one opaque statement", ops[1]?.op === "opaque" && ops.filter((o) => o.op === "opaque").length === 1, JSON.stringify(ops.map((o) => o.op)));
  check("ALTER TABLE with several actions", ops[2]?.op === "addColumn" && ops[3]?.op === "dropColumn");
  check("CREATE INDEX CONCURRENTLY with a WHERE", ops[4]?.op === "createIndex" && ops[4].concurrently === true && ops[4].index.unique === true && ops[4].index.where === "id > 0", JSON.stringify(ops[4]));
  const mysql = parseSql("CREATE TABLE `orders` (`id` int unsigned NOT NULL AUTO_INCREMENT, `code` varchar(20) DEFAULT NULL, PRIMARY KEY (`id`), KEY `idx_code` (`code`)) ENGINE=InnoDB;");
  check("MySQL table with backticks and KEY", mysql[0]?.op === "createTable" && mysql[0].pk[0] === "id" && mysql[0].indexes[0]?.name === "idx_code", JSON.stringify(mysql[0]));
  const refs = sqlTableRefs("WITH recent AS (SELECT * FROM orders) SELECT * FROM recent r, items i JOIN public.customers c ON c.id = r.customer_id");
  check("table names in a query, CTEs left out", [...refs.tables].sort().join(",") === "items,orders,public.customers" && !refs.write, refs.tables.join(","));
  check("INSERT is a write", sqlTableRefs("INSERT INTO orders (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 2").write);
  check("type narrowing", Boolean(typeNarrowing("text", "varchar(50)")) && Boolean(typeNarrowing("bigint", "int")) && Boolean(typeNarrowing("numeric(10,2)", "numeric(8,2)")) && !typeNarrowing("varchar(50)", "text"));

  const tmp = mkdtempSync(path.join(os.tmpdir(), "graphreview-db-"));
  const headDir = mkdtempSync(path.join(os.tmpdir(), "graphreview-db-head-"));
  try {
    writeTree(tmp, BASE);
    writeTree(headDir, headTree());
    const base = await analyzeRepo(tmp);
    const db = base.db;
    console.log(`\nCatalog (${db.databases.map((d) => `${d.id}: ${d.tables.length}`).join(", ")})`);

    // Prisma
    const prisma = dbOf(db, "prisma:prisma/migrations");
    check("Prisma: a database from the migrations, the schema merged in", Boolean(prisma) && prisma!.tools.includes("prisma") && prisma!.sources.some((s) => s.kind === "schema"), JSON.stringify(db.databases.map((d) => [d.id, d.sources])));
    check("Prisma: dialect from the datasource", prisma?.dialect === "postgresql" && !prisma?.dialectGuessed);
    const orders = findTable(db, "prisma:prisma/migrations", "orders");
    check("Prisma: @@map table from the migrations, with its history", orders?.source === "migration" && orders.history.length >= 2 && orders.models[0]?.name === "Order", JSON.stringify(orders?.history));
    check("Prisma: column mapped to its field (@map)", orders?.columns.find((c) => c.name === "customer_id")?.modelField === "customerId");
    check("Prisma: FK replayed from ALTER TABLE, resolved to the table id", orders?.fks[0]?.refTable === "prisma:prisma/migrations:customer" && orders.fks[0].onDelete === "CASCADE", JSON.stringify(orders?.fks));
    check("Prisma: enum from CREATE TYPE, linked from the column", prisma?.enums.some((e) => e.name === "Status" && e.values.length === 2) === true && orders?.columns.find((c) => c.name === "status")?.enum === "prisma:prisma/migrations:status");
    check("drift: a schema field with no migrated column", orders?.drift.some((d) => d.kind === "field-no-column" && d.column === "note") === true, JSON.stringify(orders?.drift));
    check("drift: the column exists only as the schema's (source badge)", orders?.columns.find((c) => c.name === "note")?.source === "schema");

    // Drizzle
    const drizzle = dbOf(db, "drizzle:web/drizzle");
    const users = findTable(db, "drizzle:web/drizzle", "users");
    const posts = findTable(db, "drizzle:web/drizzle", "posts");
    check("Drizzle: journal replayed, tables merged with pgTable", drizzle?.migrations.length === 1 && users?.sources.includes("schema") === true && users?.models[0]?.decl === "web/src/db/schema.ts#users", JSON.stringify(users));
    check("Drizzle: FK and index", posts?.fks[0]?.refTable === "drizzle:web/drizzle:users" && posts.indexes.some((i) => i.name === "posts_author_idx"), JSON.stringify(posts));
    check("Drizzle: no drift when schema and migrations agree", (users?.drift.length ?? 1) === 0 && (posts?.drift.length ?? 1) === 0, JSON.stringify([users?.drift, posts?.drift]));

    // TypeORM
    const typeorm = db.databases.find((d) => d.tools.includes("typeorm"));
    const appUser = typeorm?.tables.find((t) => t.name === "app_user");
    const photo = typeorm?.tables.find((t) => t.name === "photo");
    check("TypeORM: migration (query + createTable) replayed, entities merged (snake_case name)", appUser?.source === "migration" && appUser.models[0]?.name === "AppUser" && photo?.columns.some((c) => c.name === "ownerId") === true, JSON.stringify(typeorm?.tables.map((t) => [t.name, t.sources])));
    check("TypeORM: relation join column inferred as an FK", photo?.fks.some((f) => f.columns[0] === "ownerId" && f.inferred) === true, JSON.stringify(photo?.fks));

    // Django
    const django = dbOf(db, "django");
    const dorder = findTable(db, "django", "shop_order");
    check("Django: migrations replayed into shop_customer / shop_order", Boolean(findTable(db, "django", "shop_customer")) && dorder?.source === "migration", JSON.stringify(django?.tables.map((t) => t.name)));
    check("Django: ForeignKey → customer_id with an FK", dorder?.columns.some((c) => c.name === "customer_id") === true && dorder?.fks[0]?.refTable === "django:shop_customer", JSON.stringify(dorder?.fks));
    const attachment = findTable(db, "django", "attachment");
    check(
      "Django: CompositePrimaryKey keys the named fields, no implicit id",
      attachment?.columns.filter((c) => c.name === "id").length === 1 && JSON.stringify(attachment.columns.filter((c) => c.primary).map((c) => c.name)) === '["type","id","filename"]',
      JSON.stringify(attachment?.columns)
    );
    check("Django: model field without a migration is drift", dorder?.drift.some((d) => d.kind === "field-no-column" && d.column === "paid") === true, JSON.stringify(dorder?.drift));

    // SQLAlchemy + Alembic
    const alembic = db.databases.find((d) => d.tools.includes("alembic"));
    const items = alembic?.tables.find((t) => t.name === "items");
    check("Alembic: chain replayed (create_table, add_column), SQLAlchemy model merged", items?.history.length === 2 && items.columns.some((c) => c.name === "price" && c.type === "numeric(10,2)") && items.models[0]?.name === "Item", JSON.stringify(items));
    check("Alembic: no order problems on a straight chain", alembic?.orderProblems.length === 0, JSON.stringify(alembic?.orderProblems));

    // golang-migrate
    const gom = db.databases.find((d) => d.tools.includes("golang-migrate"));
    check("golang-migrate: .up.sql ordered by version, .down.sql ignored", gom?.migrations.map((m) => m.name).join(",") === "000001_create_users,000002_add_age" && gom.tables.find((t) => t.name === "accounts")?.columns.some((c) => c.name === "age") === true, JSON.stringify(gom?.migrations.map((m) => m.name)));
    check("golang-migrate: dialect guessed from the SQL", gom?.dialect === "postgresql" && gom.dialectGuessed === true);

    // SQL in code
    console.log("\nSQL in code");
    const hasUseOf = (table: string | undefined, file: string, via: string) => db.uses.some((u) => u.table === table && u.file === file && u.via === via);
    const inCode = dbOf(db, "sql-in-code:appdb/src/db/schema.ts");
    const appItems = inCode?.tables.find((t) => t.name === "items");
    check("a migrations array: one migration per element, in order", inCode?.migrations.map((m) => m.name).join(",") === "appdb/src/db/schema.ts #1,appdb/src/db/schema.ts #2,appdb/src/db/schema.ts #3" && inCode?.tools.includes("sql-in-code") === true, JSON.stringify(db.databases.map((d) => [d.id, d.migrations.map((m) => m.name)])));
    check("its tables, the later ALTER replayed", appItems?.source === "migration" && appItems.columns.map((c) => c.name).join(",") === "id,name,legacy,price" && appItems.indexes.length === 1 && appItems.history.length === 3, JSON.stringify(appItems));
    check("dialect from the driver import (node:sqlite), not guessed", inCode?.dialect === "sqlite" && !inCode?.dialectGuessed, String(inCode?.dialect));
    check("a statement with a template hole stays opaque", inCode?.opaque.some((o) => o.text.includes("${T}")) === true && Boolean(inCode?.tables.find((t) => t.name === "notes")), JSON.stringify(inCode?.opaque));
    check("a smoke test's DDL isn't the app's database", !db.databases.some((d) => d.tables.some((t) => t.name === "scratch")));
    check("the query file's SQL links to the in-code table", hasUseOf(appItems?.id, "appdb/src/db/items.ts", "sql"));
    check("the migrations file itself isn't a use", !db.uses.some((u) => u.file === "appdb/src/db/schema.ts"));
    // Startup runners with tagged templates, Drizzle/Kysely sql, Python cursor.execute (all loose DDL, one database).
    const loose = db.databases.find((d) => d.tables.some((t) => t.name === "members"));
    const members = loose?.tables.find((t) => t.name === "members");
    const memos = loose?.tables.find((t) => t.name === "memos");
    check("tagged sql`CREATE TABLE …` (Neon): the table, its later ALTER replayed", members?.columns.map((c) => c.name).join(",") === "id,username,invite_token", JSON.stringify(loose?.tables.map((t) => [t.name, t.columns.map((c) => c.name)])));
    check("tagged sql: FK and index across createX() functions", memos?.fks[0]?.refTable === members?.id && memos?.indexes.some((i) => i.name === "memos_member_idx") === true, JSON.stringify(memos));
    check("the runner's INSERT with a hole isn't DDL", !loose?.opaque.some((o) => /insert/i.test(o.text)), JSON.stringify(loose?.opaque));
    check("a query file's tagged SELECT links to the in-code table", hasUseOf(memos?.id, "neon/actions/memos.ts", "sql"));
    check("Drizzle db.execute(sql`…`) and Kysely sql`…`.execute(db)", loose?.tables.find((t) => t.name === "widgets")?.columns.map((c) => c.name).join(",") === "id,label,color");
    check("Python cursor.execute DDL", Boolean(loose?.tables.find((t) => t.name === "gizmos")));
    check("one CREATE per file with no file changing another's table: no order problem", loose?.orderProblems.length === 0, JSON.stringify(loose?.orderProblems));
    const goInCode = db.databases.find((d) => d.id === "sql-in-code:gosvc/store.go");
    check("a Go slice of DDL literals (lexical): migrations in element order", goInCode?.migrations.length === 2 && goInCode.tables.find((t) => t.name === "gadgets")?.columns.length === 2, JSON.stringify(goInCode?.migrations.map((m) => m.name)));

    // Links
    console.log("\nLinks");
    const hasUse = (table: string | undefined, file: string, via: string) => db.uses.some((u) => u.table === table && u.file === file && u.via === via);
    check("model: a Prisma delegate", hasUse(orders?.id, "src/orders.ts", "model"));
    check("model: a Drizzle table object (resolved through the import)", hasUse(users?.id, "web/src/feed.ts", "model"));
    check("model: a Django model class", hasUse(dorder?.id, "shop/views.py", "model"));
    check("query builder: Kysely selectFrom", hasUse(posts?.id, "web/src/feed.ts", "builder"));
    check("query builder: SQLAlchemy table()", hasUse(items?.id, "svc/app/queries.py", "builder"));
    check("SQL text: text() in Python", hasUse(items?.id, "svc/app/queries.py", "sql"));
    check("SQL text: a tagged template", hasUse(orders?.id, "src/orders.ts", "sql") && hasUse(findTable(db, "prisma:prisma/migrations", "Customer")?.id, "src/orders.ts", "sql"));
    check("SQL text: a Go string literal", hasUse(gom?.tables.find((t) => t.name === "accounts")?.id, "gosvc/main.go", "sql"));
    check("SQL text naming an unknown table is dropped", !db.uses.some((u) => u.table.endsWith(":ghosts")) && !db.databases.some((d) => d.tables.some((t) => t.name === "ghosts")));
    check("write access from the call", db.uses.some((u) => u.table === orders?.id && u.file === "src/orders.ts" && u.access === "write"));
    const getOrders = Object.entries(db.endpointTables).find(([id]) => /GET \/api\/orders/.test(id));
    check("endpoint → table through the handler's reach", getOrders?.[1].some((t) => t.table === orders?.id) === true, JSON.stringify(Object.keys(db.endpointTables)));
    const report = Object.entries(db.endpointTables).find(([id]) => /GET \/api\/report/.test(id));
    check("endpoint link from SQL text is marked", report?.[1].some((t) => t.table === orders?.id && t.via.includes("sql")) === true, JSON.stringify(report));
    check("table → endpoints", orders?.endpoints?.some((e) => e.label.includes("/api/orders")) === true);

    // Comparison
    console.log("\nComparison");
    const head = await analyzeRepo(headDir);
    const change = compareSchemas(base.db, head.db);
    const rule = (r: string, column?: string) => change.findings.find((f) => f.rule === r && (!column || f.column === column));
    check("drop-column", Boolean(rule("drop-column", "total")), JSON.stringify(change.findings.map((f) => `${f.rule} ${f.table} ${f.column ?? ""}`)));
    check("drop-table", Boolean(rule("drop-table")));
    check("not-null-no-default", Boolean(rule("not-null-no-default", "channel")));
    check("type-narrowing", Boolean(rule("type-narrowing", "email")));
    check("rename-column", Boolean(rule("rename-column", "name")));
    check("rename-table", Boolean(rule("rename-table")));
    check("index-not-concurrent (Postgres, existing table)", Boolean(rule("index-not-concurrent")));
    check("fk-no-index (Postgres)", Boolean(rule("fk-no-index", "order_id")));
    check("only the PR's migrations count: the base FK without an index isn't reported", !change.findings.some((f) => f.rule === "fk-no-index" && f.column === "customer_id"));
    check("destructive count", change.counts.destructive === 3, JSON.stringify(change.counts));
    const ordersChange = change.tables.find((t) => t.id === orders?.id);
    check("table change: columns added / removed", ordersChange?.columns.some((c) => c.name === "channel" && c.status === "added") === true && ordersChange?.columns.some((c) => c.name === "total" && c.status === "removed") === true);
    check("table change: column renamed by the migration", change.tables.some((t) => t.columns.some((c) => c.status === "renamed" && c.from === "name" && c.name === "full_name")));
    check("table renamed (golang-migrate)", change.tables.some((t) => t.status === "renamed" && t.renamedFrom === "accounts" && t.table.name === "members"));
    check("table added", change.tables.some((t) => t.status === "added" && t.table.name === "Refund"));
    check("enum value added", change.enums.some((e) => e.name === "Status" && e.added.includes("REFUNDED")));
    check("new migrations listed", change.counts.migrations === 3, JSON.stringify(change.migrations.map((m) => m.id)));
    check("drift introduced: schema field with no migration", change.drift.some((d) => d.drift.column === "coupon"), JSON.stringify(change.drift));
    check("described for prompts", describeSchemaChange(change).length > 8);
    const appended = change.findings.find((f) => f.rule === "drop-column" && f.column === "legacy");
    check("an appended array element is a migration the PR adds: its hazards are findings", appended?.migration === "appdb/src/db/schema.ts#4" && change.migrations.some((m) => m.id === "appdb/src/db/schema.ts#4"), JSON.stringify(change.findings.map((f) => [f.rule, f.migration])));
    check("an edited element is shown as an edited migration, not a new one", change.edited?.some((m) => m.id === "appdb/src/db/schema.ts#2") === true && !change.migrations.some((m) => m.id === "appdb/src/db/schema.ts#2"), JSON.stringify(change.edited));

    // Review context
    console.log("\nReview context");
    const paths = new Set(["src/orders.ts"]);
    const ids = tablesTouching(head.db, change, paths);
    const tables = reviewTables(ids, head.db, change, paths);
    check("a component's tables: what its code uses, changed first", tables.length === 2 && tables.every((t) => t.changed) && tables.some((t) => t.name === "orders") && tables.some((t) => t.name === "Customer"), JSON.stringify(tables.map((t) => t.name)));
    const prompt = renderRelatedSections({ tables, alreadyReported: change.findings.map((f) => f.summary) });
    check("the prompt shows the new NOT NULL column and the dropped one", prompt.includes("## Tables this code touches") && /\+ channel text NOT NULL/.test(prompt) && /− total/.test(prompt) && prompt.includes("new NOT NULL column"), prompt);
    check("…and the new enum value", prompt.includes("REFUNDED"));
    // Through the review call itself, with a tight budget: the tables survive the related-context fit.
    let sent = "";
    const big = { path: "big.ts", componentName: "other", relation: "imported" as const, signatures: Array.from({ length: 200 }, (_, i) => `function f${i}(a: string, b: number): Promise<void>`), snippets: [{ name: "x", code: "x".repeat(20000) }] };
    await reviewComponentChange(
      { baseUrl: "http://localhost:0", apiKey: "x", model: "m" },
      {
        intent: { source: "ref_comparison" },
        component: { id: "c", name: "orders", dependsOn: [], dependents: [] },
        files: [{ path: "src/orders.ts", patch: "@@ -1,1 +1,1 @@\n-a\n+b\n" }],
        related: { files: [big], tables },
      },
      {
        tokenBudget: 3000,
        chat: async (_config, messages) => {
          sent = messages.map((m) => m.content).join("\n");
          return { content: '```json\n{"findings": []}\n```', usage: null };
        },
      },
    );
    check("tables survive fitRelatedContext (related code trimmed first)", sent.includes("## Tables this code touches") && sent.includes("+ channel") && !sent.includes("x".repeat(5000)), sent.slice(0, 400));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(headDir, { recursive: true, force: true });
  }

  // --- .sql read by content, and a pinned source file (2026-10-11) ---
  console.log("\n.sql by content");
  const sqlDir = "app/src/main/resources/sql";
  const creates = (withEmail: boolean) =>
    lines(
      "-- the tables",
      `CREATE TABLE users (id BIGINT PRIMARY KEY, name VARCHAR(100) NOT NULL${withEmail ? ", email VARCHAR(200)" : ""});`,
      "CREATE TABLE orders (id BIGINT PRIMARY KEY, user_id BIGINT REFERENCES users(id));",
    );
  const changes = (...blocks: string[][]) => lines(...blocks.flat());
  const block1 = ["-- 2024-01: users get an email", "ALTER TABLE users ADD COLUMN email VARCHAR(200);"];
  const block2 = ["", "-- 2024-02: index orders by user", "CREATE INDEX orders_user ON orders (user_id);"];
  const analyse = async (files: Record<string, string>, dbSource?: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "graphreview-db-sqlfiles-"));
    try {
      writeTree(dir, files);
      return (await analyzeRepo(dir, dbSource ? { dbSource } : {})).db;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const users = (s: DbSchema) => s.databases[0]?.tables.find((t) => t.name === "users");

  // A: the changes apply cleanly → creates + changes.
  const caseA = await analyse({ [`${sqlDir}/create-tables.sql`]: creates(false), [`${sqlDir}/schema-changes.sql`]: changes(block1, block2) });
  const aDb = caseA.databases[0];
  check(
    "A: a schema file and its change log (any names) → one database, changes applied",
    caseA.databases.length === 1 && users(caseA)?.columns.some((c) => c.name === "email") === true && aDb.migrations.length === 3 && aDb.orderProblems.length === 0,
    JSON.stringify(caseA.databases.map((d) => [d.id, d.migrations.map((m) => m.name), d.orderProblems])),
  );
  check("A: each comment-led block is a migration, read as table history", users(caseA)?.history.some((h) => h.name.includes("users get an email") && /add column email/.test(h.summary)) === true, JSON.stringify(users(caseA)?.history));
  // B: the creates already include the changes → creates are the schema, changes are history.
  const caseB = await analyse({ [`${sqlDir}/create-tables.sql`]: creates(true), [`${sqlDir}/schema-changes.sql`]: changes(block1, block2.map((l) => l.replace("orders_user", "orders_user_idx")).slice(0, 2)) });
  check(
    "B: changes already in the creates → history only, no problem",
    users(caseB)?.columns.filter((c) => c.name === "email").length === 1 && caseB.databases[0]?.orderProblems.length === 0 && caseB.databases[0]?.migrations.slice(1).every((m) => m.historyOnly) === true && users(caseB)?.history.some((h) => /add column email/.test(h.summary)) === true,
    JSON.stringify(caseB.databases[0]),
  );
  // Mixed: one change is already there, one isn't → creates as written, the conflict named.
  const caseMixed = await analyse({ [`${sqlDir}/create-tables.sql`]: creates(true), [`${sqlDir}/schema-changes.sql`]: changes(block1, ["", "-- phones", "ALTER TABLE users ADD COLUMN phone VARCHAR(30);"]) });
  const mixedProblem = caseMixed.databases[0]?.orderProblems.join(" ") ?? "";
  check(
    "mixed: creates as written, and an order problem naming what didn't fit",
    /schema-changes\.sql:2 adds email, which users already has/.test(mixedProblem) && !users(caseMixed)?.columns.some((c) => c.name === "phone"),
    mixedProblem,
  );
  // A renamed-anything file of CREATE TABLEs, and a folder that can't be paired.
  const renamed = await analyse({ "db/stuff/tables-v2.sql": creates(false) });
  check("a .sql file of CREATE TABLEs, whatever its name, is a schema source", renamed.databases[0]?.tables.length === 2, JSON.stringify(renamed.databases.map((d) => d.id)));
  const unpaired = await analyse({ [`${sqlDir}/a.sql`]: creates(false), [`${sqlDir}/b.sql`]: lines("CREATE TABLE things (id INT);"), [`${sqlDir}/changes.sql`]: changes(block1) });
  check("two schema files and a change file → no pairing, the problem shown", unpaired.databases.some((d) => d.orderProblems.some((p) => /which changes go with which schema is unknown/.test(p))), JSON.stringify(unpaired.databases.map((d) => d.orderProblems)));
  const testOnly = await analyse({ "src/test/resources/fixture.sql": creates(false) });
  check("a test path's .sql isn't a schema source (but is a candidate)", testOnly.databases.length === 0 && testOnly.candidates?.[0]?.test === true, JSON.stringify(testOnly));
  // A PR appending a block to the change log: its statements are migrations the PR adds.
  const prBase = await analyse({ [`${sqlDir}/create-tables.sql`]: creates(false), [`${sqlDir}/schema-changes.sql`]: changes(block1, block2) });
  const prHead = await analyse({ [`${sqlDir}/create-tables.sql`]: creates(false), [`${sqlDir}/schema-changes.sql`]: changes(block1, block2, ["", "-- 2024-03: names go", "ALTER TABLE users DROP COLUMN name;"]) });
  const appendedChange = compareSchemas(prBase, prHead);
  check("a block appended to the change log is a migration the PR adds → drop-column finding", appendedChange.findings.some((f) => f.rule === "drop-column" && f.column === "name" && f.migration.endsWith("schema-changes.sql#3")), JSON.stringify(appendedChange.findings));
  const grownHead = await analyse({ [`${sqlDir}/create-tables.sql`]: creates(false), [`${sqlDir}/schema-changes.sql`]: changes(block1, block2, ["ALTER TABLE users DROP COLUMN name;"]) });
  const grown = compareSchemas(prBase, grownHead);
  check("statements appended to the last block count as added too, not as an edit", grown.findings.some((f) => f.rule === "drop-column" && f.column === "name") && !(grown.edited ?? []).length, JSON.stringify([grown.findings, grown.edited]));

  console.log("\nPinned source");
  const pinnedTree = {
    "prisma/schema.prisma": PRISMA_SCHEMA(),
    "docs/model.sql": lines("CREATE TABLE things (id INT PRIMARY KEY, label TEXT);", "ALTER TABLE things ADD COLUMN label TEXT;", "ALTER TABLE things ADD COLUMN size INT;"),
    "src/schema.ts": lines("export const M = [", "  `CREATE TABLE widgets (id TEXT PRIMARY KEY)`,", "  `ALTER TABLE widgets ADD COLUMN name TEXT`,", "];"),
  };
  const auto = await analyse(pinnedTree);
  check("auto-detection finds the Prisma schema (and SQL in code)", auto.databases.some((d) => d.tools.includes("prisma")) && !auto.pinned, JSON.stringify(auto.databases.map((d) => d.id)));
  const pinSql = await analyse(pinnedTree, "docs/model.sql");
  const things = pinSql.databases[0]?.tables.find((t) => t.name === "things");
  check(
    "a pinned .sql replaces auto-detection: one database, line order, a clashing ALTER kept opaque and listed",
    pinSql.databases.length === 1 && pinSql.databases[0].id === "pinned:docs/model.sql" && things?.columns.map((c) => c.name).join(",") === "id,label,size" && pinSql.databases[0].orderProblems.some((p) => /adds label, which things already has/.test(p)) && pinSql.pinned?.file === "docs/model.sql",
    JSON.stringify(pinSql.databases[0]),
  );
  const pinPrisma = await analyse({ ...pinnedTree, "db/other.sql": creates(false) }, "prisma/schema.prisma");
  check("a pinned .prisma is read as a Prisma schema, nothing else", pinPrisma.databases.length === 1 && pinPrisma.databases[0].tables.some((t) => t.name === "orders") && !pinPrisma.databases[0].tables.some((t) => t.name === "users"), JSON.stringify(pinPrisma.databases.map((d) => [d.id, d.tables.map((t) => t.name)])));
  const pinCode = await analyse(pinnedTree, "src/schema.ts");
  check("a pinned code file is read for its DDL literals", pinCode.databases.length === 1 && pinCode.databases[0].tables[0]?.name === "widgets" && pinCode.databases[0].tables[0].columns.length === 2 && pinCode.databases[0].migrations.length === 2, JSON.stringify(pinCode.databases[0]));
  const pinMissing = await analyse(pinnedTree, "db/gone.sql");
  check("a pinned file missing at a commit is a problem, not an empty schema", pinMissing.pinned?.missing === true && pinMissing.databases[0]?.orderProblems.some((p) => /isn't in this commit/.test(p)) === true, JSON.stringify(pinMissing));
  const candidates = auto.candidates?.map((c) => c.file) ?? [];
  check("candidates: files with schema statements, by CREATE TABLE count", candidates.includes("docs/model.sql") && candidates.includes("prisma/schema.prisma") && candidates.includes("src/schema.ts"), JSON.stringify(auto.candidates));

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall schema checks passed");
}

void main();
