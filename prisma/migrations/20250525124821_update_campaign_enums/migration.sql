/*
  Warnings:

  - The values [CONVERSIONS,APP_INSTALLS] on the enum `CampaignObjective` will be removed. If these variants are still used in the database, this will fail.
  - The values [SPONSORED_UPDATES,DISPLAY_AD,SEARCH_AD] on the enum `CampaignType` will be removed. If these variants are still used in the database, this will fail.
  - The values [MAX_CLICK,MAX_LEAD] on the enum `OptimizationTargetType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "CampaignObjective_new" AS ENUM ('BRAND_AWARENESS', 'ENGAGEMENT', 'VIDEO_VIEWS', 'WEBSITE_VISIT', 'LEAD_GENERATION', 'WEBSITE_CONVERSIONS', 'JOB_APPLICANTS', 'REACH');
ALTER TABLE "MarketingCampaign" ALTER COLUMN "objective" TYPE "CampaignObjective_new" USING ("objective"::text::"CampaignObjective_new");
ALTER TYPE "CampaignObjective" RENAME TO "CampaignObjective_old";
ALTER TYPE "CampaignObjective_new" RENAME TO "CampaignObjective";
DROP TYPE "CampaignObjective_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "CampaignType_new" AS ENUM ('SPONSORED_CONTENT', 'TEXT_AD', 'DYNAMIC_AD', 'VIDEO_AD', 'EVENT_AD', 'CONVERSATION_AD');
ALTER TABLE "MarketingCampaign" ALTER COLUMN "type" TYPE "CampaignType_new" USING ("type"::text::"CampaignType_new");
ALTER TYPE "CampaignType" RENAME TO "CampaignType_old";
ALTER TYPE "CampaignType_new" RENAME TO "CampaignType";
DROP TYPE "CampaignType_old";
COMMIT;

-- AlterEnum
ALTER TYPE "CostType" ADD VALUE 'CPV';

-- AlterEnum
BEGIN;
CREATE TYPE "OptimizationTargetType_new" AS ENUM ('MAX_REACH', 'MAX_IMPRESSIONS', 'MAX_CLICKS', 'MAX_LANDING_PAGE_VIEWS', 'MAX_LEADS', 'MAX_CONVERSIONS');
ALTER TABLE "MarketingCampaign" ALTER COLUMN "optimization_target_type" TYPE "OptimizationTargetType_new" USING ("optimization_target_type"::text::"OptimizationTargetType_new");
ALTER TYPE "OptimizationTargetType" RENAME TO "OptimizationTargetType_old";
ALTER TYPE "OptimizationTargetType_new" RENAME TO "OptimizationTargetType";
DROP TYPE "OptimizationTargetType_old";
COMMIT;

-- CreateTable
CREATE TABLE "LinkedInMetadata" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,
    "objective" JSONB,
    "type" JSONB,
    "format" JSONB,
    "cost_type" JSONB,
    "optimization_target" JSONB,
    "pacing_strategy" JSONB,
    "targeting_industries" JSONB,
    "targeting_locations" JSONB,
    "targeting_seniorities" JSONB,
    "targeting_titles" JSONB,
    "targeting_staff_count_ranges" JSONB,
    "targeting_locales" JSONB,
    "last_updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInMetadata_org_id_platform_id_key" ON "LinkedInMetadata"("org_id", "platform_id");
