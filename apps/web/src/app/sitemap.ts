import type { MetadataRoute } from "next";

import { getFeedData } from "@/lib/server/feed-data";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { posts, pages, categories, tags, siteConfig } = await getFeedData();

  // 规范化 baseUrl：去除首尾空白与结尾斜杠，避免拼接出双斜杠
  const normalizedBaseUrl = (
    siteConfig.url?.trim() || "https://www.kryos-x.top"
  ).replace(/\/+$/, "");

  // 统一的 URL 构造函数：清理 slug 两侧的斜杠，彻底避免出现 "//"
  const buildUrl = (path: string): string => {
    const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
    return clean ? `${normalizedBaseUrl}/${clean}` : normalizedBaseUrl;
  };

  const postEntries: MetadataRoute.Sitemap = posts.map((post) => ({
    url: buildUrl(`posts/${post.slug}`),
    lastModified: post.updatedAt,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  // 数据中的 page.slug 可能以 "/" 开头，且包含 ":page"、":slug" 之类的
  // 系统路由模板（非真实可访问页面）。这里统一过滤与规范化。
  const pageEntries: MetadataRoute.Sitemap = pages
    .filter((page) => {
      const slug = (page.slug ?? "").trim();
      if (!slug) return false;
      // 过滤系统模板页（含占位符冒号）
      if (slug.includes(":")) return false;
      // 过滤首页（首页由下方单独添加），避免重复
      const clean = slug.replace(/^\/+/, "").replace(/\/+$/, "");
      if (clean === "") return false;
      return true;
    })
    .map((page) => ({
      url: buildUrl(page.slug),
      lastModified: page.updatedAt,
      changeFrequency: "monthly",
      priority: 0.5,
    }));

  const categoryEntries: MetadataRoute.Sitemap = categories.map((category) => ({
    url: buildUrl(`categories/${category.slug}`),
    lastModified: category.updatedAt,
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  const tagEntries: MetadataRoute.Sitemap = tags.map((tag) => ({
    url: buildUrl(`tags/${tag.slug}`),
    lastModified: tag.updatedAt,
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  return [
    {
      url: normalizedBaseUrl,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    ...postEntries,
    ...pageEntries,
    ...categoryEntries,
    ...tagEntries,
  ];
}
