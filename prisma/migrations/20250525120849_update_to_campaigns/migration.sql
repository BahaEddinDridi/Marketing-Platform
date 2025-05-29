-- CreateEnum
CREATE TYPE "OptimizationTargetType" AS ENUM ('MAX_REACH', 'MAX_CLICK', 'MAX_LEAD');

-- AlterTable
ALTER TABLE "MarketingCampaign" ADD COLUMN     "associated_entity" TEXT,
ADD COLUMN     "creative_selection" TEXT,
ADD COLUMN     "currency_code" TEXT,
ADD COLUMN     "offsite_delivery_enabled" BOOLEAN DEFAULT false,
ADD COLUMN     "optimization_target_type" "OptimizationTargetType",
ADD COLUMN     "version_tag" TEXT;
