import { revalidatePath, revalidateTag } from "next/cache";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import prisma from "@/lib/server/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 临时运维端点：一次性内容维护（站点改名 / 文案替换）。
 * 由环境变量 OPS_TOKEN 保护，任务完成后立即删除本文件。
 */

const TOKEN = process.env.OPS_TOKEN ?? "";

function authorized(request: NextRequest): boolean {
  if (!TOKEN) return false;
  const provided =
    request.headers.get("x-ops-token") ??
    new URL(request.url).searchParams.get("token") ??
    "";
  if (provided.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

type Replacement = [string, string, "exact" | "contains"];

interface PagePatch {
  slug: string;
  replacements?: Replacement[];
  meta?: {
    title?: string;
    metaDescription?: string;
    metaKeywords?: string;
  };
}

interface ConfigPatch {
  key: string;
  value?: unknown;
  defaultValue?: unknown;
}

interface OpsBody {
  dryRun?: boolean;
  configs?: ConfigPatch[];
  pages?: PagePatch[];
}

interface WalkStats {
  inspected: number;
  changed: number;
  examples: Array<{ from: string; to: string; count: number }>;
}

function record(stats: WalkStats, from: string, to: string): void {
  const existing = stats.examples.find((item) => item.from === from);
  if (existing) existing.count += 1;
  else stats.examples.push({ from, to, count: 1 });
  stats.changed += 1;
}

function applyReplacements(input: string, replacements: Replacement[]): string {
  let output = input;
  for (const [from, to, mode] of replacements) {
    if (!from) continue;
    if (mode === "contains") {
      if (output.includes(from)) output = output.split(from).join(to);
    } else if (output === from) {
      output = to;
    }
  }
  return output;
}

function walk(
  node: unknown,
  replacements: Replacement[],
  stats: WalkStats,
): unknown {
  if (typeof node === "string") {
    stats.inspected += 1;
    const next = applyReplacements(node, replacements);
    if (next !== node) {
      const matched = replacements.find(
        ([from, , mode]) =>
          from && (mode === "contains" ? node.includes(from) : node === from),
      );
      if (matched) record(stats, matched[0], matched[1]);
    }
    return next;
  }
  if (Array.isArray(node)) return node.map((item) => walk(item, replacements, stats));
  if (node && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      result[key] = walk(value, replacements, stats);
    }
    return result;
  }
  return node;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") ?? "health";
  const slug = url.searchParams.get("slug");

  try {
    if (mode === "dump") {
      const pages = await prisma.page.findMany({
        where: { ...(slug ? { slug } : {}), deletedAt: null },
        select: {
          id: true,
          slug: true,
          title: true,
          contentType: true,
          status: true,
          config: true,
          metaDescription: true,
          metaKeywords: true,
        },
        orderBy: { createdAt: "asc" },
      });
      const configs = await prisma.config.findMany({ orderBy: { key: "asc" } });
      return NextResponse.json({ ok: true, pages, configs });
    }

    if (mode === "pages") {
      const pages = await prisma.page.findMany({
        where: { deletedAt: null },
        select: {
          slug: true,
          title: true,
          contentType: true,
          status: true,
          metaDescription: true,
        },
        orderBy: { slug: "asc" },
      });
      return NextResponse.json({ ok: true, pages });
    }

    const configs = await prisma.config.findMany({ orderBy: { key: "asc" } });
    return NextResponse.json({
      ok: true,
      mode,
      tokenConfigured: TOKEN.length > 0,
      configKeys: configs.map((c) => c.key),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: OpsBody;
  try {
    body = (await request.json()) as OpsBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const dryRun = body.dryRun !== false;
  const report: Record<string, unknown> = { ok: true, dryRun };

  try {
    const configResults: unknown[] = [];
    for (const patch of body.configs ?? []) {
      const existing = await prisma.config.findUnique({ where: { key: patch.key } });
      const oldValue = existing?.value as unknown;
      let nextValue: unknown;
      if (patch.value !== undefined) {
        nextValue = patch.value;
      } else if (
        oldValue &&
        typeof oldValue === "object" &&
        !Array.isArray(oldValue) &&
        "default" in (oldValue as Record<string, unknown>)
      ) {
        nextValue = { ...(oldValue as Record<string, unknown>), default: patch.defaultValue };
      } else {
        nextValue = patch.defaultValue;
      }
      configResults.push({ key: patch.key, existed: Boolean(existing), oldValue, nextValue });
      if (!dryRun) {
        await prisma.config.upsert({
          where: { key: patch.key },
          update: { value: nextValue as never },
          create: { key: patch.key, value: nextValue as never },
        });
      }
    }
    report.configs = configResults;

    const pageResults: unknown[] = [];
    const changedPageIds: string[] = [];
    for (const patch of body.pages ?? []) {
      const page = await prisma.page.findFirst({
        where: { slug: patch.slug, deletedAt: null },
        select: { id: true, slug: true, config: true, title: true },
      });
      if (!page) {
        pageResults.push({ slug: patch.slug, found: false });
        continue;
      }
      const stats: WalkStats = { inspected: 0, changed: 0, examples: [] };
      const nextConfig =
        page.config && patch.replacements?.length
          ? walk(page.config, patch.replacements, stats)
          : page.config;

      pageResults.push({
        slug: patch.slug,
        found: true,
        pageId: page.id,
        stringsInspected: stats.inspected,
        stringsChanged: stats.changed,
        examples: stats.examples,
        meta: patch.meta ?? null,
      });

      if (!dryRun) {
        await prisma.page.update({
          where: { id: page.id },
          data: {
            ...(patch.replacements?.length ? { config: nextConfig as never } : {}),
            ...(patch.meta?.title ? { title: patch.meta.title } : {}),
            ...(patch.meta?.metaDescription !== undefined
              ? { metaDescription: patch.meta.metaDescription }
              : {}),
            ...(patch.meta?.metaKeywords !== undefined
              ? { metaKeywords: patch.meta.metaKeywords }
              : {}),
          },
        });
        changedPageIds.push(page.id);
      }
    }
    report.pages = pageResults;

    if (!dryRun) {
      const tags = new Set<string>(["config", "menus", "pages"]);
      for (const key of (body.configs ?? []).map((c) => c.key)) {
        tags.add(`config/${key}`);
      }
      for (const id of changedPageIds) tags.add(`pages/${id}`);
      for (const tag of tags) {
        try {
          revalidateTag(tag, "max");
        } catch {
          // 忽略标签刷新异常，不影响数据写入结果
        }
      }
      for (const path of ["/", "/about", "/admin"]) {
        try {
          revalidatePath(path, "max");
        } catch {
          // 忽略
        }
      }
    }

    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        dryRun,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  }
}
