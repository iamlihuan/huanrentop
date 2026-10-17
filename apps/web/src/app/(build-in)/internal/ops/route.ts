import type { NextRequest } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import prisma from "@/lib/server/prisma";

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

export async function GET(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug") ?? "/";
  const page = await prisma.page.findFirst({
    where: { slug, deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      contentType: true,
      content: true,
      config: true,
      status: true,
      updatedAt: true,
      metaDescription: true,
      metaKeywords: true,
    },
  });
  return NextResponse.json({ ok: true, page });
}

interface PageWrite {
  slug: string;
  title?: string;
  contentType?: "MARKDOWN" | "HTML" | "MDX" | "BLOCK" | "BUILDIN";
  content?: string;
  config?: unknown;
  metaDescription?: string;
  metaKeywords?: string;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { pages?: PageWrite[] };
  try {
    body = (await request.json()) as { pages?: PageWrite[] };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const results: unknown[] = [];
  for (const patch of body.pages ?? []) {
    const page = await prisma.page.findFirst({
      where: { slug: patch.slug, deletedAt: null },
      select: { id: true },
    });
    if (!page) {
      results.push({ slug: patch.slug, found: false });
      continue;
    }
    try {
      await prisma.page.update({
        where: { id: page.id },
        data: {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.contentType !== undefined ? { contentType: patch.contentType } : {}),
          ...(patch.content !== undefined ? { content: patch.content } : {}),
          ...(patch.config !== undefined ? { config: patch.config as never } : {}),
          ...(patch.metaDescription !== undefined
            ? { metaDescription: patch.metaDescription }
            : {}),
          ...(patch.metaKeywords !== undefined
            ? { metaKeywords: patch.metaKeywords }
            : {}),
        },
      });
      const after = await prisma.page.findUnique({
        where: { id: page.id },
        select: {
          id: true,
          contentType: true,
          updatedAt: true,
          content: true,
          metaDescription: true,
        },
      });
      results.push({
        slug: patch.slug,
        found: true,
        id: page.id,
        contentType: after?.contentType,
        updatedAt: after?.updatedAt,
        contentLength: after?.content?.length ?? 0,
        contentHead: after?.content?.slice(0, 80),
        metaDescription: after?.metaDescription,
      });
    } catch (error) {
      results.push({
        slug: patch.slug,
        found: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const tag of ["config", "menus", "pages"]) {
    try {
      revalidateTag(tag, "max");
    } catch {
      // ignore
    }
  }
  for (const path of ["/", "/about", "/MinecraftServer"]) {
    try {
      revalidatePath(path, "max");
    } catch {
      // ignore
    }
  }

  return NextResponse.json({ ok: true, results });
}
