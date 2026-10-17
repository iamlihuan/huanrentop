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
  const mode = url.searchParams.get("mode") ?? "peek";
  const slug = url.searchParams.get("slug") ?? "/";

  if (mode === "menus") {
    const menus = await prisma.menu.findMany({
      select: {
        id: true,
        name: true,
        link: true,
        slug: true,
        icon: true,
        order: true,
        category: true,
        status: true,
        pageId: true,
      },
      orderBy: { order: "asc" },
    });
    return NextResponse.json({ ok: true, menus });
  }

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

interface MenuWrite {
  name: string;
  link: string;
  slug?: string;
  icon?: string;
  order?: number;
  category?: string;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { pages?: PageWrite[]; menus?: MenuWrite[] };
  try {
    body = (await request.json()) as { pages?: PageWrite[]; menus?: MenuWrite[] };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const pageResults: unknown[] = [];
  for (const patch of body.pages ?? []) {
    const page = await prisma.page.findFirst({
      where: { slug: patch.slug, deletedAt: null },
      select: { id: true },
    });
    if (!page) {
      pageResults.push({ slug: patch.slug, found: false });
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
        select: { contentType: true, updatedAt: true, content: true, metaDescription: true },
      });
      pageResults.push({
        slug: patch.slug,
        found: true,
        contentType: after?.contentType,
        updatedAt: after?.updatedAt,
        contentLength: after?.content?.length ?? 0,
        metaDescription: after?.metaDescription,
      });
    } catch (error) {
      pageResults.push({
        slug: patch.slug,
        found: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const menuResults: unknown[] = [];
  for (const menu of body.menus ?? []) {
    try {
      const existing = await prisma.menu.findFirst({
        where: { link: menu.link },
        select: { id: true },
      });
      if (existing) {
        menuResults.push({ name: menu.name, link: menu.link, exists: true, id: existing.id });
        continue;
      }
      const created = await prisma.menu.create({
        data: {
          name: menu.name,
          link: menu.link,
          ...(menu.slug ? { slug: menu.slug } : {}),
          ...(menu.icon ? { icon: menu.icon } : {}),
          order: menu.order ?? 0,
          ...(menu.category
            ? { category: menu.category as never }
            : {}),
        },
        select: { id: true, name: true, link: true, order: true, category: true },
      });
      menuResults.push({ ...created, exists: false });
    } catch (error) {
      menuResults.push({
        name: menu.name,
        link: menu.link,
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

  return NextResponse.json({ ok: true, pages: pageResults, menus: menuResults });
}
