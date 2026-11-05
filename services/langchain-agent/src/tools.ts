/**
 * The agent's two tools: the Zudocs help centre and the customer's plan. Both answer from fixed demo data, so a
 * request costs model calls and nothing else.
 *
 * @example
 * ```ts
 * await searchDocs.invoke({ query: "pdf export" }); // the matching articles as one string
 * ```
 */

import { tool } from "langchain";
import { z } from "zod";

const ARTICLES = [
  { title: "Exporting to PDF", body: "PDF export is on the Team and Enterprise plans. Exports over 500 pages run in the background and arrive by email." },
  { title: "Custom domains", body: "Custom domains are on every paid plan. Point a CNAME at docs.zudocs.example and allow an hour for the certificate." },
  { title: "Inviting editors", body: "Starter has 3 editor seats, Team has 20, and Enterprise has no limit. Viewers are free on every plan." },
  { title: "Version history", body: "Starter keeps 30 days of history. Team keeps 1 year, and Enterprise keeps everything." },
] as const;

const CUSTOMERS: Record<string, { plan: string; seatsUsed: number }> = {
  "acme-docs": { plan: "Starter", seatsUsed: 3 },
  "northwind": { plan: "Team", seatsUsed: 12 },
  "fabrikam": { plan: "Enterprise", seatsUsed: 140 },
};

export function matchArticles(query: string): string {
  const words = query.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
  const found = ARTICLES.filter((article) => words.some((word) => `${article.title} ${article.body}`.toLowerCase().includes(word)));
  return found.length > 0 ? found.map((article) => `${article.title}: ${article.body}`).join("\n") : "No article matches that search.";
}

export function planOf(customer: string): string {
  const row = CUSTOMERS[customer];
  return row ? `${customer} is on ${row.plan} with ${row.seatsUsed} editor seats in use.` : `No customer is named ${customer}.`;
}

export const searchDocs = tool(async ({ query }) => matchArticles(query), {
  name: "search_docs",
  description: "Search the Zudocs help centre.",
  schema: z.object({ query: z.string() }),
});

export const getCustomerPlan = tool(async ({ customer }) => planOf(customer), {
  name: "get_customer_plan",
  description: "Look up a customer's plan and editor seats.",
  schema: z.object({ customer: z.string() }),
});
