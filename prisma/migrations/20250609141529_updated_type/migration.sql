/*
  Warnings:

  - The values [EVENT] on the enum `CampaignType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "CampaignType_new" AS ENUM ('SPONSORED_UPDATES', 'SPONSORED_INMAILS', 'SPONSORED_CONTENT', 'TEXT_AD', 'DYNAMIC', 'SPOTLIGHT', 'EVENT_AD');
ALTER TABLE "MarketingCampaign" ALTER COLUMN "type" TYPE "CampaignType_new" USING ("type"::text::"CampaignType_new");
ALTER TYPE "CampaignType" RENAME TO "CampaignType_old";
ALTER TYPE "CampaignType_new" RENAME TO "CampaignType";
DROP TYPE "CampaignType_old";
COMMIT;

-- AlterEnum
ALTER TYPE "OptimizationTargetType" ADD VALUE 'MAX_VIDEO_VIEW';
