/**
 * Checks for the schema catalog (lib/analysis/db/) and the schema
 * comparison: one fixture per v1 source — a Prisma schema with migrations,
 * Drizzle tables with a journal, TypeORM entities with a migration, a
 * Django app with migrations, SQLAlchemy models with an Alembic chain, a
 * golang-migrate folder — merging and drift, the endpoint links (model,
 * query builder, SQL text — a literal naming an unknown table is dropped),
 * a head whose migrations produce each finding, and the review context.
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

const BASE: Record<string, string> = {
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
    check("destructive count", change.counts.destructive === 2, JSON.stringify(change.counts));
    const ordersChange = change.tables.find((t) => t.id === orders?.id);
    check("table change: columns added / removed", ordersChange?.columns.some((c) => c.name === "channel" && c.status === "added") === true && ordersChange?.columns.some((c) => c.name === "total" && c.status === "removed") === true);
    check("table change: column renamed by the migration", change.tables.some((t) => t.columns.some((c) => c.status === "renamed" && c.from === "name" && c.name === "full_name")));
    check("table renamed (golang-migrate)", change.tables.some((t) => t.status === "renamed" && t.renamedFrom === "accounts" && t.table.name === "members"));
    check("table added", change.tables.some((t) => t.status === "added" && t.table.name === "Refund"));
    check("enum value added", change.enums.some((e) => e.name === "Status" && e.added.includes("REFUNDED")));
    check("new migrations listed", change.counts.migrations === 2, JSON.stringify(change.migrations.map((m) => m.id)));
    check("drift introduced: schema field with no migration", change.drift.some((d) => d.drift.column === "coupon"), JSON.stringify(change.drift));
    check("described for prompts", describeSchemaChange(change).length > 8);

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

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall schema checks passed");
}

void main();
