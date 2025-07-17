-- CreateEnum
CREATE TYPE "GoogleCampaignStatus" AS ENUM ('ENABLED', 'PAUSED', 'REMOVED');

-- CreateEnum
CREATE TYPE "GoogleCampaignPrimaryStatus" AS ENUM ('ELIGIBLE', 'ENDED', 'LEARNING', 'LIMITED', 'MISCONFIGURED', 'NOT_ELIGIBLE', 'PAUSED', 'PENDING', 'REMOVED', 'UNKNOWN', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "GoogleObjectiveType" AS ENUM ('SALES', 'LEADS', 'WEBSITE_TRAFFIC', 'APP_PROMOTION', 'AWARENESS');

-- CreateEnum
CREATE TYPE "GoogleAdvertisingChannelType" AS ENUM ('DEMAND_GEN', 'DISPLAY', 'HOTEL', 'LOCAL', 'LOCAL_SERVICES', 'MULTI_CHANNEL', 'PERFORMANCE_MAX', 'SEARCH', 'SHOPPING', 'SMART', 'TRAVEL', 'UNKNOWN', 'UNSPECIFIED', 'VIDEO');

-- CreateEnum
CREATE TYPE "GoogleBudgetDeliveryMethod" AS ENUM ('STANDARD', 'ACCELERATED');

-- CreateEnum
CREATE TYPE "GoogleServingStatus" AS ENUM ('ENDED', 'NONE', 'PENDING', 'SERVING', 'SUSPENDED', 'UNKNOWN', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "GoogleGeoTargetType" AS ENUM ('PRESENCE_OR_INTEREST', 'PRESENCE', 'SEARCH_INTEREST');

-- CreateEnum
CREATE TYPE "GoogleAdGroupStatus" AS ENUM ('ENABLED', 'PAUSED', 'REMOVED');

-- CreateEnum
CREATE TYPE "GoogleAdStatus" AS ENUM ('ENABLED', 'PAUSED', 'REMOVED');

-- CreateEnum
CREATE TYPE "GoogleAdType" AS ENUM ('RESPONSIVE_SEARCH_AD', 'EXPANDED_TEXT_AD', 'RESPONSIVE_DISPLAY_AD', 'VIDEO_AD', 'SHOPPING_PRODUCT_AD');

-- CreateEnum
CREATE TYPE "GoogleAdGroupRotation" AS ENUM ('OPTIMIZE', 'ROTATE_FOREVER', 'UNKNOWN', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CLICKS', 'CONVERSIONS', 'CONVERSION_VALUE', 'GUEST_STAY', 'UNKNOWN', 'UNSPECIFIED');

-- CreateTable
CREATE TABLE "GoogleCampaign" (
    "campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT NOT NULL,
    "platform_id" TEXT,
    "customer_account_id" TEXT NOT NULL,
    "objective_type" "GoogleObjectiveType",
    "advertising_channel_type" "GoogleAdvertisingChannelType",
    "status" "GoogleCampaignStatus" NOT NULL DEFAULT 'PAUSED',
    "serving_status" "GoogleServingStatus" DEFAULT 'NONE',
    "bidding_strategy_type" TEXT,
    "bidding_strategy_system_status" TEXT,
    "payment_mode" "PaymentMode",
    "primary_status" "GoogleCampaignPrimaryStatus",
    "primary_status_reasons" TEXT[],
    "campaign_budget" JSONB,
    "network_settings" JSONB,
    "geo_target_type_setting" JSONB,
    "target_cpa_micros" DOUBLE PRECISION,
    "target_roas" DOUBLE PRECISION,
    "geo_targets" JSONB,
    "languages" JSONB,
    "audience_settings" JSONB,
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "data" JSONB,

    CONSTRAINT "GoogleCampaign_pkey" PRIMARY KEY ("campaign_id")
);

-- CreateTable
CREATE TABLE "GoogleAdGroup" (
    "ad_group_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "ad_rotation_mode" "GoogleAdGroupRotation",
    "name" TEXT NOT NULL,
    "status" "GoogleAdGroupStatus" NOT NULL DEFAULT 'PAUSED',
    "cpc_bid_micros" DOUBLE PRECISION,
    "cpm_bid_micros" DOUBLE PRECISION,
    "target_cpa_micros" DOUBLE PRECISION,
    "target_cpm_micros" DOUBLE PRECISION,
    "targeting_settings" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "data" JSONB,

    CONSTRAINT "GoogleAdGroup_pkey" PRIMARY KEY ("ad_group_id")
);

-- CreateTable
CREATE TABLE "GoogleAd" (
    "ad_id" TEXT NOT NULL,
    "ad_group_id" TEXT NOT NULL,
    "status" "GoogleAdStatus" NOT NULL DEFAULT 'PAUSED',
    "ad_type" "GoogleAdType",
    "ad_content" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "data" JSONB,

    CONSTRAINT "GoogleAd_pkey" PRIMARY KEY ("ad_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleCampaign_campaign_id_key" ON "GoogleCampaign"("campaign_id");

-- CreateIndex
CREATE INDEX "GoogleCampaign_customer_account_id_idx" ON "GoogleCampaign"("customer_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdGroup_ad_group_id_key" ON "GoogleAdGroup"("ad_group_id");

-- CreateIndex
CREATE INDEX "GoogleAdGroup_campaign_id_idx" ON "GoogleAdGroup"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAd_ad_id_key" ON "GoogleAd"("ad_id");

-- CreateIndex
CREATE INDEX "GoogleAd_ad_group_id_idx" ON "GoogleAd"("ad_group_id");

-- AddForeignKey
ALTER TABLE "GoogleCampaign" ADD CONSTRAINT "GoogleCampaign_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "MarketingPlatform"("platform_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleCampaign" ADD CONSTRAINT "GoogleCampaign_customer_account_id_fkey" FOREIGN KEY ("customer_account_id") REFERENCES "AdAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleAdGroup" ADD CONSTRAINT "GoogleAdGroup_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "GoogleCampaign"("campaign_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleAd" ADD CONSTRAINT "GoogleAd_ad_group_id_fkey" FOREIGN KEY ("ad_group_id") REFERENCES "GoogleAdGroup"("ad_group_id") ON DELETE RESTRICT ON UPDATE CASCADE;
