/**
 * Checks for the endpoint catalog (lib/analysis/api/) and the API
 * comparison: one small fixture app per framework, analysed from disk.
 *
 *   npx tsx lib/analysis/api/smoke-test-api.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChangedLines } from "../compare";
import { analyzeRepo } from "../graph-builder";
import { compareApis } from "./compare";
import { normalizeApiShape } from "../../ai/api-shape";
import type { ApiCatalog, Endpoint } from "./types";

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

const list = (api: ApiCatalog) => api.endpoints.map((e) => `${e.kind} ${e.method} ${e.path}${e.partial ? " (partial)" : ""} [${e.framework}]`).join("\n    ");
const find = (api: ApiCatalog, method: string, p: string, framework?: string): Endpoint | undefined =>
  api.endpoints.find((e) => e.method === method && e.path === p && (!framework || e.framework === framework));

const FIXTURES: Record<string, string> = {
  // --- Next.js --------------------------------------------------------------
  "web/next.config.js": "module.exports = { basePath: '' };\n",
  "web/middleware.ts": "export function middleware() {}\nexport const config = { matcher: ['/api/:path*'] };\n",
  "web/app/api/orders/route.ts": [
    "import { z } from 'zod';",
    "import { insertOrder } from '../../../lib/db/orders';",
    "const CreateOrder = z.object({ sku: z.string(), qty: z.number().optional() });",
    "export async function POST(req: Request) {",
    "  const body = CreateOrder.parse(await req.json());",
    "  return Response.json(await insertOrder(body));",
    "}",
  ].join("\n"),
  "web/app/api/orders/[id]/route.ts": [
    "export async function GET(req: Request, { params }: { params: { id: string } }) { return Response.json({}); }",
    "export const DELETE = withAuth(async (req: Request) => Response.json({}));",
    "function withAuth(f: any) { return f; }",
  ].join("\n"),
  "web/app/(shop)/checkout/actions.ts": [
    "'use server';",
    "export async function placeOrder(input: { sku: string; qty: number }) { return input; }",
    "async function notExported() {}",
  ].join("\n"),
  "web/app/(shop)/checkout/page.tsx": "import { placeOrder } from './actions';\nexport default function Page() { return <form action={() => placeOrder({ sku: 'a', qty: 1 })} />; }\n",
  "web/pages/api/legacy.ts": "export default function handler(req: any, res: any) { res.json({}); }\n",
  "web/lib/db/orders.ts": "export async function insertOrder(o: unknown) { return o; }\n",
  "web/lib/client.ts": "import axios from 'axios';\nexport const load = () => axios.get('/api/orders', { params: {} });\n",

  // --- Express (ESM, mounted across files) ----------------------------------
  "api/package.json": "{}\n",
  "api/src/app.ts": [
    "import express from 'express';",
    "import cors from 'cors';",
    "import apiRouter from './routes';",
    "const app = express();",
    "app.use(cors());",
    "app.use('/api', apiRouter);",
    "export default app;",
  ].join("\n"),
  "api/src/routes/index.ts": [
    "import { Router } from 'express';",
    "import usersRouter from './users';",
    "import { requireAuth } from '../auth';",
    "const router = Router();",
    "router.use('/users', requireAuth, usersRouter);",
    "export default router;",
  ].join("\n"),
  "api/src/routes/users.ts": [
    "import express from 'express';",
    "import { getUser } from '../controllers/users';",
    "import { saveUser } from '../db/users';",
    "const router = express.Router();",
    "router.get('/:id', getUser);",
    "router.post('/', async (req, res) => { res.json(await saveUser(req.body)); });",
    "router.route('/:id/avatar').put(async (req, res) => { res.end(); });",
    "export default router;",
  ].join("\n"),
  "api/src/controllers/users.ts": "import { findUser } from '../db/users';\nexport async function getUser(req: any, res: any) { res.json(await findUser(req.params.id)); }\n",
  "api/src/db/users.ts": "export async function findUser(id: string) { return query(id); }\nexport async function saveUser(u: unknown) { return u; }\nfunction query(id: string) { return { id }; }\n",
  "api/src/auth.ts": "export function requireAuth(req: any, res: any, next: any) { next(); }\n",

  // --- Express (CommonJS) ---------------------------------------------------
  "legacy/server.js": "const express = require('express');\nconst items = require('./items');\nconst app = express();\napp.use('/items', items);\napp.listen(3000);\n",
  "legacy/items.js": "const express = require('express');\nconst router = express.Router();\nrouter.get('/', (req, res) => res.json([]));\nmodule.exports = router;\n",

  // --- Fastify plugin with a prefix -----------------------------------------
  "fast/server.ts": [
    "import Fastify from 'fastify';",
    "import { booksPlugin } from './books';",
    "const app = Fastify();",
    "app.register(booksPlugin, { prefix: '/v1/books' });",
  ].join("\n"),
  "fast/books.ts": [
    "import type { FastifyInstance } from 'fastify';",
    "export async function booksPlugin(fastify: FastifyInstance) {",
    "  fastify.get('/:isbn', { schema: { params: { type: 'object', properties: { isbn: { type: 'string' } } }, response: { 200: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } } }, async () => ({ title: 'x' }));",
    "}",
  ].join("\n"),

  // --- Hono -----------------------------------------------------------------
  "edge/index.ts": "import { Hono } from 'hono';\nimport { notes } from './notes';\nconst app = new Hono().basePath('/edge');\napp.route('/notes', notes);\nexport default app;\n",
  "edge/notes.ts": "import { Hono } from 'hono';\nexport const notes = new Hono();\nnotes.get('/', (c) => c.json([]));\nnotes.delete('/:id', (c) => c.body(null));\n",

  // --- NestJS ---------------------------------------------------------------
  "nest/cats.controller.ts": [
    "import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';",
    "export class CreateCatDto { name: string; age?: number; }",
    "export interface CreateCatBody { name: string; age?: number }",
    "@Controller('cats')",
    "@UseGuards(AuthGuard)",
    "export class CatsController {",
    "  @Get(':id')",
    "  findOne(@Param('id') id: string): Promise<CreateCatBody> { return null as any; }",
    "  @Post()",
    "  create(@Body() dto: CreateCatBody) { return dto; }",
    "}",
  ].join("\n"),

  // --- FastAPI --------------------------------------------------------------
  "py/app/main.py": "from fastapi import FastAPI\nfrom .routers import users\napp = FastAPI()\napp.include_router(users.router, prefix='/api')\n",
  "py/app/routers/__init__.py": "",
  "py/app/routers/users.py": [
    "from fastapi import APIRouter, Depends",
    "from pydantic import BaseModel",
    "from ..deps import get_current_user",
    "router = APIRouter(prefix='/users')",
    "class User(BaseModel):",
    "    id: int",
    "    email: str",
    "    nickname: str | None = None",
    "class UserIn(BaseModel):",
    "    email: str",
    "@router.get('/{user_id}', response_model=User)",
    "async def read_user(user_id: int, verbose: bool = False, me=Depends(get_current_user)):",
    "    return load(user_id)",
    "@router.post('/')",
    "async def create_user(body: UserIn):",
    "    return body",
    "def load(uid):",
    "    return uid",
  ].join("\n"),
  "py/app/deps.py": "def get_current_user():\n    return None\n",

  // --- Flask ----------------------------------------------------------------
  "flaskapp/app.py": "from flask import Flask\nfrom .shop import bp\napp = Flask(__name__)\napp.register_blueprint(bp, url_prefix='/shop')\n",
  "flaskapp/__init__.py": "",
  "flaskapp/shop.py": "from flask import Blueprint\nbp = Blueprint('shop', __name__)\n@bp.route('/items/<int:item_id>', methods=['GET', 'PUT'])\n@login_required\ndef item(item_id):\n    return ''\n",

  // --- Django + DRF ---------------------------------------------------------
  "dj/project/urls.py": "from django.urls import path, include\nurlpatterns = [path('api/', include('shop.urls'))]\n",
  "dj/shop/__init__.py": "",
  "dj/shop/urls.py": [
    "from django.urls import path, include",
    "from rest_framework.routers import DefaultRouter",
    "from . import views",
    "router = DefaultRouter()",
    "router.register(r'orders', views.OrderViewSet)",
    "urlpatterns = [path('items/<int:pk>/', views.item_detail), path('', include(router.urls))]",
  ].join("\n"),
  "dj/shop/views.py": [
    "from rest_framework import viewsets, permissions",
    "from rest_framework.decorators import api_view, action",
    "from .serializers import OrderSerializer",
    "class OrderViewSet(viewsets.ModelViewSet):",
    "    serializer_class = OrderSerializer",
    "    permission_classes = [permissions.IsAuthenticated]",
    "    @action(detail=True, methods=['post'])",
    "    def cancel(self, request, pk=None):",
    "        return None",
    "@api_view(['GET'])",
    "def item_detail(request, pk):",
    "    return None",
  ].join("\n"),
  "dj/shop/serializers.py": "from rest_framework import serializers\nclass OrderSerializer(serializers.Serializer):\n    total = serializers.DecimalField(max_digits=8)\n    note = serializers.CharField(required=False)\n",

  // --- Spring + JAX-RS ------------------------------------------------------
  "jvm/src/main/java/com/acme/web/OrderController.java": [
    "package com.acme.web;",
    "import org.springframework.web.bind.annotation.*;",
    "@RestController",
    "@RequestMapping(\"/orders\")",
    "public class OrderController {",
    "  @GetMapping(\"/{id}\")",
    "  @PreAuthorize(\"hasRole('USER')\")",
    "  public ResponseEntity<OrderDto> get(@PathVariable Long id, @RequestParam(required = false) String expand) { return null; }",
    "  @PostMapping",
    "  public OrderDto create(@RequestBody CreateOrder body) { return null; }",
    "}",
  ].join("\n"),
  "jvm/src/main/java/com/acme/web/OrderDto.java": "package com.acme.web;\npublic record OrderDto(Long id, String status) {}\n",
  "jvm/src/main/java/com/acme/web/CreateOrder.java": "package com.acme.web;\npublic class CreateOrder { private String sku; private int qty; }\n",
  "jvm/src/main/java/com/acme/web/PingResource.java": "package com.acme.web;\nimport jakarta.ws.rs.*;\n@Path(\"/ping\")\npublic class PingResource {\n  @GET\n  public String ping() { return \"pong\"; }\n}\n",

  // --- Spring in Kotlin ------------------------------------------------------
  "kt/src/main/kotlin/com/acme/shop/CartController.kt": [
    "package com.acme.shop",
    "import org.springframework.web.bind.annotation.*",
    "data class CartDto(val id: Long, val items: List<String>, val note: String? = null)",
    "@RestController",
    "@RequestMapping(\"/carts\")",
    "class CartController(private val service: CartService) {",
    "    @GetMapping(\"/{id}\")",
    "    @PreAuthorize(\"isAuthenticated()\")",
    "    fun get(@PathVariable id: Long, @RequestParam(required = false) expand: Boolean?): CartDto {",
    "        return service.load(id)",
    "    }",
    "    @DeleteMapping(value = [\"/{id}\", \"/{id}/all\"])",
    "    fun clear(@PathVariable id: Long) = service.clear(id)",
    "}",
  ].join("\n"),

  // --- tRPC -----------------------------------------------------------------
  "rpc/server/routers/user.ts": [
    "import { z } from 'zod';",
    "import { router, publicProcedure, protectedProcedure } from '../trpc';",
    "export const userRouter = router({",
    "  byId: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => input),",
    "  rename: protectedProcedure.input(z.object({ id: z.string(), name: z.string() })).mutation(({ input }) => input),",
    "});",
  ].join("\n"),
  "rpc/server/routers/_app.ts": "import { router, publicProcedure } from '../trpc';\nimport { userRouter } from './user';\nexport const appRouter = router({ user: userRouter, health: publicProcedure.query(() => 'ok') });\n",
  "rpc/server/trpc.ts": "export const router = (x: any) => x;\nexport const publicProcedure: any = {};\nexport const protectedProcedure: any = {};\n",

  // --- GraphQL (schema-first) -----------------------------------------------
  "gql/schema.graphql": [
    "type Book { id: ID!\n title: String!\n author: String }",
    "type Query {",
    "  \"\"\"All books\"\"\"",
    "  books(limit: Int): [Book!]!",
    "  book(id: ID!): Book",
    "}",
    "type Mutation { addBook(title: String!): Book! }",
  ].join("\n"),
  "gql/resolvers.ts": "export const resolvers = {\n  Query: {\n    books: () => [],\n    book: (_: unknown, { id }: { id: string }) => ({ id }),\n  },\n};\n",

  // --- SvelteKit / Nuxt ------------------------------------------------------
  "kit/src/routes/(app)/todos/[id]/+server.ts": "export async function GET() { return new Response(); }\nexport const DELETE = async () => new Response();\n",
  "nuxt/server/api/carts/[id].post.ts": "export default defineEventHandler(async (event) => ({}));\n",

  // --- OpenAPI --------------------------------------------------------------
  "api/openapi.yaml": [
    "openapi: 3.0.0",
    "info: { title: x, version: '1' }",
    "paths:",
    "  /api/users/{id}:",
    "    get:",
    "      summary: Get a user",
    "      operationId: getUser",
    "      responses:",
    "        '200':",
    "          description: ok",
    "          content:",
    "            application/json:",
    "              schema: { $ref: '#/components/schemas/User' }",
    "  /api/users/{id}/friends:",
    "    get:",
    "      summary: Not built yet",
    "      responses: { '200': { description: ok } }",
    "components:",
    "  schemas:",
    "    User:",
    "      type: object",
    "      required: [id]",
    "      properties: { id: { type: string }, name: { type: string } }",
  ].join("\n"),
};

async function main(): Promise<void> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "graphreview-api-"));
  try {
    writeTree(tmp, FIXTURES);
    const result = await analyzeRepo(tmp);
    const api = result.api;
    console.log(`  (${api.endpoints.length} endpoints)\n    ${list(api)}`);

    console.log("next.js");
    const post = find(api, "POST", "/api/orders");
    check("route handler POST /api/orders", post?.framework === "Next.js");
    check("zod body read from .parse()", post?.request?.fields?.map((f) => `${f.name}${f.required ? "" : "?"}`).join(",") === "sku,qty?", JSON.stringify(post?.request));
    check("middleware.ts matcher applies", post?.auth.includes("middleware.ts") === true, post?.auth.join());
    check("reach goes down to the db function", post?.reach.some((s) => s.id.endsWith("#insertOrder") && s.data) === true, JSON.stringify(post?.reach));
    check("dynamic segment → {id}", find(api, "GET", "/api/orders/{id}")?.params.some((p) => p.name === "id" && p.in === "path") === true);
    check("wrapped handler's wrapper is auth", find(api, "DELETE", "/api/orders/{id}")?.auth.includes("withAuth") === true);
    check("pages/api default export is ANY", find(api, "ANY", "/api/legacy") !== undefined);
    const action = api.endpoints.find((e) => e.kind === "action");
    check("server action listed as internal", action?.path === "placeOrder" && action.internal === true && action.group === "checkout", JSON.stringify(action));
    check("server action callers", action?.callers?.some((c) => c.endsWith("page.tsx")) === true);
    check("unexported function in a use-server file is not an action", !api.endpoints.some((e) => e.path === "notExported"));
    check("axios.get is not an endpoint", !api.endpoints.some((e) => e.handler?.file === "web/lib/client.ts"));

    console.log("express");
    const getUser = find(api, "GET", "/api/users/{id}");
    check("mounted across three files", getUser?.framework === "Express", list(api));
    check("router-level middleware inherited, cors dropped", getUser?.auth.join() === "requireAuth", getUser?.auth.join());
    check("named handler resolved through import", getUser?.handler?.declId === "api/src/controllers/users.ts#getUser");
    check("reach: controller → db → query", getUser?.reach.map((s) => `${s.depth}:${s.id.split("#")[1]}`).join() === "1:findUser,2:query", JSON.stringify(getUser?.reach));
    check("inline handler reach", find(api, "POST", "/api/users", "Express")?.reach.some((s) => s.id.endsWith("#saveUser")) === true);
    check("router.route() chain", find(api, "PUT", "/api/users/{id}/avatar") !== undefined);
    check("spec merged into code endpoint", getUser?.spec?.operationId === "getUser" && getUser.response?.source === "spec");
    check("spec-only endpoint is drift", find(api, "GET", "/api/users/{id}/friends")?.drift === "spec-only");
    check("code-only endpoint is drift", find(api, "POST", "/api/users", "Express")?.drift === "code-only");
    check("CommonJS require + module.exports", find(api, "GET", "/items")?.framework === "Express");

    console.log("fastify / hono / nest");
    const book = find(api, "GET", "/v1/books/{isbn}");
    check("fastify plugin under register prefix", book?.framework === "Fastify", list(api));
    check("fastify response schema", book?.response?.fields?.[0]?.name === "title" && book.response.fields[0].required === true);
    check("hono basePath + route()", find(api, "DELETE", "/edge/notes/{id}")?.framework === "Hono");
    const cat = find(api, "GET", "/cats/{id}");
    check("nest controller", cat?.framework === "NestJS" && cat.auth.includes("AuthGuard"), JSON.stringify(cat));
    check("nest body interface fields", find(api, "POST", "/cats")?.request?.fields?.map((f) => f.name).join() === "name,age");

    console.log("python");
    const readUser = find(api, "GET", "/api/users/{user_id}");
    check("fastapi include_router prefix + router prefix", readUser?.framework === "FastAPI", list(api));
    check("fastapi response_model fields", readUser?.response?.fields?.map((f) => f.name).join() === "id,email,nickname");
    check("fastapi Depends is auth", readUser?.auth.includes("get_current_user") === true);
    check("fastapi query param", readUser?.params.some((p) => p.name === "verbose" && p.in === "query" && !p.required) === true);
    check("fastapi pydantic body", find(api, "POST", "/api/users", "FastAPI")?.request?.fields?.[0]?.name === "email");
    check("same route in two services kept apart", api.endpoints.filter((e) => e.method === "POST" && e.path === "/api/users").length === 2);
    check("fastapi reach", readUser?.reach.some((s) => s.id.endsWith("#load")) === true);
    const flaskItem = api.endpoints.filter((e) => e.path === "/shop/items/{item_id}");
    check("flask blueprint, methods=[GET, PUT]", flaskItem.map((e) => e.method).sort().join() === "GET,PUT", list(api));
    check("flask decorator as auth", flaskItem[0]?.auth.includes("login_required") === true);
    check("django include + api_view", find(api, "GET", "/api/items/{pk}")?.framework === "Django REST");
    const orders = api.endpoints.filter((e) => e.path.startsWith("/api/orders") && e.framework === "Django REST");
    check("drf router: ModelViewSet routes + @action", orders.length === 7, orders.map((e) => `${e.method} ${e.path}`).join(", "));
    check("drf serializer shape + permission", orders.find((e) => e.method === "POST" && e.path === "/api/orders")?.request?.fields?.map((f) => `${f.name}${f.required ? "" : "?"}`).join() === "total,note?" && orders[0].auth.includes("permissions.IsAuthenticated"));

    console.log("jvm");
    const order = find(api, "GET", "/orders/{id}");
    check("spring controller", order?.framework === "Spring", list(api));
    check("spring PreAuthorize", order?.auth[0]?.startsWith("PreAuthorize") === true);
    check("spring optional request param", order?.params.some((p) => p.name === "expand" && p.in === "query" && p.required === false) === true);
    check("spring response record fields", order?.response?.fields?.map((f) => f.name).join() === "id,status", JSON.stringify(order?.response));
    check("spring request body class fields", find(api, "POST", "/orders")?.request?.fields?.map((f) => f.name).join() === "sku,qty");
    check("jax-rs", find(api, "GET", "/ping")?.framework === "JAX-RS");
    const cart = find(api, "GET", "/carts/{id}");
    check("kotlin spring controller", cart?.framework === "Spring", list(api));
    check("kotlin data class response", cart?.response?.fields?.map((f) => `${f.name}${f.required ? "" : "?"}`).join() === "id,items,note?", JSON.stringify(cart?.response));
    check("kotlin optional param + PreAuthorize", cart?.params.some((p) => p.name === "expand" && p.required === false) === true && cart.auth[0]?.startsWith("PreAuthorize") === true);
    check("kotlin array of paths", find(api, "DELETE", "/carts/{id}/all") !== undefined);

    console.log("file routes");
    check("sveltekit +server.ts", find(api, "DELETE", "/todos/{id}")?.framework === "SvelteKit", list(api));
    check("nuxt server/api with method suffix", find(api, "POST", "/api/carts/{id}")?.framework === "Nuxt");

    console.log("rpc");
    const byId = api.endpoints.find((e) => e.kind === "trpc" && e.path === "user.byId");
    check("trpc nested router through import", byId?.method === "QUERY", list(api));
    check("trpc input fields", byId?.request?.fields?.[0]?.name === "id");
    check("trpc protected procedure as auth", api.endpoints.find((e) => e.path === "user.rename")?.auth.includes("protectedProcedure") === true);
    check("trpc root procedure", api.endpoints.some((e) => e.kind === "trpc" && e.path === "health"));
    const books = api.endpoints.find((e) => e.kind === "graphql" && e.path === "books");
    check("graphql SDL field + resolver handler", books?.handler?.file === "gql/resolvers.ts", JSON.stringify(books));
    check("graphql response type fields", api.endpoints.find((e) => e.path === "book")?.response?.fields?.map((f) => f.name).join() === "id,title,author");
    check("graphql mutation", api.endpoints.some((e) => e.kind === "graphql" && e.method === "MUTATION" && e.path === "addBook"));
    check("spec files listed", api.specs.join() === "api/openapi.yaml");

    console.log("inferred shapes");
    const shape = normalizeApiShape({ summary: " Creates a user. ", params: [{ name: "dry", in: "query" }, { name: "x", in: "body" }], request: { type: "null", fields: [{ name: "email", type: "string" }, { name: "age", required: false }, { nope: 1 }] }, response: null });
    check("model answer normalised", shape?.summary === "Creates a user." && shape.params.length === 1 && shape.request?.fields.length === 2 && shape.request.fields[1].required === false && !shape.request.type && !shape.response, JSON.stringify(shape));
    check("garbage answer is null", normalizeApiShape("no") === null);

    // --- Comparison ----------------------------------------------------------
    console.log("compare");
    const headDir = path.join(tmp, "..", `${path.basename(tmp)}-head`);
    writeTree(headDir, {
      ...FIXTURES,
      // GET gains a required query param; avatar route removed; query() changed deep below getUser.
      "api/src/routes/users.ts": [
        "import express from 'express';",
        "import { getUser } from '../controllers/users';",
        "import { saveUser } from '../db/users';",
        "const router = express.Router();",
        "router.get('/:id', getUser);",
        "router.post('/', async (req, res) => { res.json(await saveUser(req.body)); });",
        "router.get('/:id/sessions', async (req, res) => { res.json([]); });",
        "export default router;",
      ].join("\n"),
      "api/src/db/users.ts": "export async function findUser(id: string) { return query(id); }\nexport async function saveUser(u: unknown) { return u; }\nfunction query(id: string) { return { id, cached: true }; }\n",
      "py/app/routers/users.py": FIXTURES["py/app/routers/users.py"].replace("    nickname: str | None = None\n", ""),
    });
    try {
      const head = await analyzeRepo(headDir);
      const changed = new Map<string, ChangedLines>([
        ["api/src/routes/users.ts", { added: new Set([7]), removed: new Set([7]) }],
        ["api/src/db/users.ts", { added: new Set([3]), removed: new Set([3]) }],
        ["py/app/routers/users.py", { added: new Set<number>(), removed: new Set([8]) }],
      ]);
      const diff = compareApis(result, head, changed);
      const by = (status: string, method: string, p: string) => diff.changes.find((c) => c.status === status && c.endpoint.method === method && c.endpoint.path === p);
      check("added endpoint", by("added", "GET", "/api/users/{id}/sessions") !== undefined, diff.changes.map((c) => `${c.status} ${c.endpoint.method} ${c.endpoint.path}`).join(", "));
      check("removed endpoint is breaking", by("removed", "PUT", "/api/users/{id}/avatar")?.breaking === true);
      check("code changed behind an endpoint is not an API change", !diff.changes.some((c) => c.endpoint.method === "GET" && c.endpoint.path === "/api/users/{id}"));
      const logic = diff.logic.find((l) => l.endpoint.method === "GET" && l.endpoint.path === "/api/users/{id}");
      check("logic change: reached through two calls, with the path", logic?.reaches[0]?.path.map((p) => p.name).join(" → ") === "findUser → query" && !logic.handlerChanged, JSON.stringify(logic));
      check("a model field edit is not a handler change", diff.logic.some((l) => l.endpoint.path === "/api/users/{user_id}" && l.handlerChanged) === false);
      const pyChange = by("changed", "GET", "/api/users/{user_id}");
      check("response field removed is breaking", pyChange?.breaking === true && pyChange.deltas.some((d) => d.aspect === "response" && d.before?.startsWith("nickname")), JSON.stringify(pyChange?.deltas));
      check("counts", diff.counts.added === 1 && diff.counts.removed === 1 && diff.counts.breaking >= 2, JSON.stringify(diff.counts));
    } finally {
      rmSync(headDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall API checks passed");
}

void main();
