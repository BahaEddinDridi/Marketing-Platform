/*
  Warnings:

  - The values [DYNAMIC_AD,VIDEO_AD,EVENT_AD,CONVERSATION_AD] on the enum `CampaignType` will be removed. If these variants are still used in the database, this will fail.
  - The values [CPA] on the enum `CostType` will be removed. If these variants are still used in the database, this will fail.
  - The values [MAX_IMPRESSIONS,MAX_CLICKS,MAX_LANDING_PAGE_VIEWS,MAX_LEADS,MAX_CONVERSIONS] on the enum `OptimizationTargetType` will be removed. If these variants are still used in the database, this will fail.
  - The `objectiveType` column on the `CampaignGroup` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `objective` column on the `MarketingCampaign` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `status` on the `CampaignGroup` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "ObjectiveType" AS ENUM ('BRAND_AWARENESS', 'ENGAGEMENT', 'JOB_APPLICANTS', 'LEAD_GENERATION', 'WEBSITE_CONVERSION', 'WEBSITE_VISITS', 'VIDEO_VIEWS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CampaignStatus" ADD VALUE 'PENDING_DELETION';
ALTER TYPE "CampaignStatus" ADD VALUE 'CANCELED';

-- AlterEnum
BEGIN;
CREATE TYPE "CampaignType_new" AS ENUM ('SPONSORED_UPDATES', 'SPONSORED_INMAILS', 'SPONSORED_CONTENT', 'TEXT_AD', 'DYNAMIC', 'SPOTLIGHT', 'EVENT');
ALTER TABLE "MarketingCampaign" ALTER COLUMN "type" TYPE "CampaignType_new" USING ("type"::text::"CampaignType_new");
ALTER TYPE "CampaignType" RENAME TO "CampaignType_old";
ALTER TYPE "CampaignType_new" RENAME TO "CampaignType";
DROP TYPE "CampaignType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "CostType_new" AS ENUM ('CPM', 'CPC', 'CPV');
ALTER TABLE "MarketingCampaign" ALTER COLUMN "cost_type" TYPE "CostType_new" USING ("cost_type"::text::"CostType_new");
ALTER TYPE "CostType" RENAME TO "CostType_old";
ALTER TYPE "CostType_new" RENAME TO "CostType";
DROP TYPE "CostType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "OptimizationTargetType_new" AS ENUM ('NONE', 'MAX_CLICK', 'MAX_IMPRESSION', 'MAX_CONVERSION', 'MAX_LEAD', 'MAX_LANDING_PAGE_VIEW', 'MAX_REACH');
ALTER TABLE "MarketingCampaign" ALTER COLUMN "optimization_target_type" TYPE "OptimizationTargetType_new" USING ("optimization_target_type"::text::"OptimizationTargetType_new");
ALTER TYPE "OptimizationTargetType" RENAME TO "OptimizationTargetType_old";
ALTER TYPE "OptimizationTargetType_new" RENAME TO "OptimizationTargetType";
DROP TYPE "OptimizationTargetType_old";
COMMIT;

-- AlterTable
ALTER TABLE "CampaignGroup" DROP COLUMN "status",
ADD COLUMN     "status" "CampaignStatus" NOT NULL,
DROP COLUMN "objectiveType",
ADD COLUMN     "objectiveType" "ObjectiveType";

-- AlterTable
ALTER TABLE "MarketingCampaign" ALTER COLUMN "status" SET DEFAULT 'DRAFT',
DROP COLUMN "objective",
ADD COLUMN     "objective" "ObjectiveType";

-- DropEnum
DROP TYPE "CampaignObjective";
