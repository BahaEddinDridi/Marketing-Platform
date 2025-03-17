/*
  Warnings:

  - The `status` column on the `Campaign` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `sync_status` column on the `MarketingPlatform` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('CONNECTED', 'SYNCING', 'FAILED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED');

-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "status",
ADD COLUMN     "status" "CampaignStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "CampaignPerformance" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "clicks" SET DEFAULT 0,
ALTER COLUMN "impressions" SET DEFAULT 0,
ALTER COLUMN "conversions" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "MarketingPlatform" DROP COLUMN "sync_status",
ADD COLUMN     "sync_status" "SyncStatus" NOT NULL DEFAULT 'CONNECTED';

-- AlterTable
ALTER TABLE "PlatformCredentials" ALTER COLUMN "refresh_token" DROP NOT NULL;
