/*
  Warnings:

  - Added the required column `updated_at` to the `CampaignPerformance` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CampaignObjective" AS ENUM ('LEAD_GENERATION', 'BRAND_AWARENESS', 'WEBSITE_VISIT', 'ENGAGEMENT', 'CONVERSIONS', 'APP_INSTALLS', 'VIDEO_VIEWS', 'REACH');

-- CreateEnum
CREATE TYPE "CampaignType" AS ENUM ('SPONSORED_UPDATES', 'SPONSORED_CONTENT', 'TEXT_AD', 'DYNAMIC_AD', 'VIDEO_AD', 'DISPLAY_AD', 'SEARCH_AD');

-- CreateEnum
CREATE TYPE "CostType" AS ENUM ('CPM', 'CPC', 'CPA');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CampaignStatus" ADD VALUE 'DRAFT';
ALTER TYPE "CampaignStatus" ADD VALUE 'ARCHIVED';

-- AlterTable
ALTER TABLE "CampaignPerformance" ADD COLUMN     "leads" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reach" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "MarketingCampaign" ADD COLUMN     "ad_account_id" TEXT,
ADD COLUMN     "audience_expansion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "campaign_group_id" TEXT,
ADD COLUMN     "cost_type" "CostType",
ADD COLUMN     "data" JSONB,
ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "format" TEXT,
ADD COLUMN     "locale" TEXT,
ADD COLUMN     "objective" "CampaignObjective",
ADD COLUMN     "pacing_strategy" TEXT,
ADD COLUMN     "serving_statuses" TEXT[],
ADD COLUMN     "total_budget" DOUBLE PRECISION,
ADD COLUMN     "type" "CampaignType",
ADD COLUMN     "unit_cost" DOUBLE PRECISION,
ALTER COLUMN "budget" DROP NOT NULL;
