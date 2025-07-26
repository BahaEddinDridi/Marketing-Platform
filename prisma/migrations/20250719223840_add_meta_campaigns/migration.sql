-- CreateEnum
CREATE TYPE "MetaBidStrategy" AS ENUM ('LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS');

-- CreateEnum
CREATE TYPE "MetaBuyingType" AS ENUM ('AUCTION', 'RESERVED');

-- CreateEnum
CREATE TYPE "MetaCampaignOptimizationType" AS ENUM ('NONE', 'ICO_ONLY');

-- CreateEnum
CREATE TYPE "MetaObjective" AS ENUM ('APP_INSTALLS', 'BRAND_AWARENESS', 'CONVERSIONS', 'EVENT_RESPONSES', 'LEAD_GENERATION', 'LINK_CLICKS', 'LOCAL_AWARENESS', 'MESSAGES', 'OFFER_CLAIMS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_TRAFFIC', 'PAGE_LIKES', 'POST_ENGAGEMENT', 'PRODUCT_CATALOG_SALES', 'REACH', 'STORE_VISITS', 'VIDEO_VIEWS');

-- CreateEnum
CREATE TYPE "MetaSpecialAdCategory" AS ENUM ('NONE', 'EMPLOYMENT', 'HOUSING', 'CREDIT', 'ISSUES_ELECTIONS_POLITICS', 'ONLINE_GAMBLING_AND_GAMING', 'FINANCIAL_PRODUCTS_SERVICES');

-- CreateEnum
CREATE TYPE "MetaCampaignStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MetaEffectiveStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES');

-- CreateEnum
CREATE TYPE "MetaAdSetStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MetaBillingEvent" AS ENUM ('APP_INSTALLS', 'CLICKS', 'IMPRESSIONS', 'LINK_CLICKS', 'NONE', 'OFFER_CLAIMS', 'PAGE_LIKES', 'POST_ENGAGEMENT', 'THRUPLAY', 'PURCHASE', 'LISTING_INTERACTION');

-- CreateEnum
CREATE TYPE "MetaOptimizationGoal" AS ENUM ('NONE', 'APP_INSTALLS', 'AD_RECALL_LIFT', 'ENGAGED_USERS', 'EVENT_RESPONSES', 'IMPRESSIONS', 'LEAD_GENERATION', 'QUALITY_LEAD', 'LINK_CLICKS', 'OFFSITE_CONVERSIONS', 'PAGE_LIKES', 'POST_ENGAGEMENT', 'QUALITY_CALL', 'REACH', 'LANDING_PAGE_VIEWS', 'VISIT_INSTAGRAM_PROFILE', 'VALUE', 'THRUPLAY', 'DERIVED_EVENTS', 'APP_INSTALLS_AND_OFFSITE_CONVERSIONS', 'CONVERSATIONS', 'IN_APP_VALUE', 'MESSAGING_PURCHASE_CONVERSION', 'SUBSCRIBERS', 'REMINDERS_SET', 'MEANINGFUL_CALL_ATTEMPT', 'PROFILE_VISIT', 'PROFILE_AND_PAGE_ENGAGEMENT', 'ADVERTISER_SILOED_VALUE', 'AUTOMATIC_OBJECTIVE', 'MESSAGING_APPOINTMENT_CONVERSION');

-- CreateEnum
CREATE TYPE "MetaPacingType" AS ENUM ('STANDARD', 'NO_PACING');

-- CreateEnum
CREATE TYPE "MetaAdStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "MetaCampaign" (
    "campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT NOT NULL,
    "platform_id" TEXT,
    "ad_account_id" TEXT NOT NULL,
    "objective" "MetaObjective" NOT NULL,
    "bid_strategy" "MetaBidStrategy",
    "buying_type" "MetaBuyingType" DEFAULT 'AUCTION',
    "optimization_type" "MetaCampaignOptimizationType" DEFAULT 'NONE',
    "special_ad_categories" "MetaSpecialAdCategory"[] DEFAULT ARRAY['NONE']::"MetaSpecialAdCategory"[],
    "status" "MetaCampaignStatus" NOT NULL DEFAULT 'PAUSED',
    "effective_status" "MetaEffectiveStatus" DEFAULT 'PAUSED',
    "daily_budget" INTEGER,
    "lifetime_budget" INTEGER,
    "spend_cap" INTEGER,
    "budget_remaining" TEXT,
    "issues_info" JSONB,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "data" JSONB,

    CONSTRAINT "MetaCampaign_pkey" PRIMARY KEY ("campaign_id")
);

-- CreateTable
CREATE TABLE "MetaAdSet" (
    "ad_set_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MetaAdSetStatus" NOT NULL DEFAULT 'PAUSED',
    "billing_event" "MetaBillingEvent",
    "optimization_goal" "MetaOptimizationGoal",
    "bid_amount" INTEGER,
    "daily_budget" INTEGER,
    "lifetime_budget" INTEGER,
    "pacing_type" "MetaPacingType"[] DEFAULT ARRAY['STANDARD']::"MetaPacingType"[],
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "targeting" JSONB,
    "promoted_object" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "data" JSONB,

    CONSTRAINT "MetaAdSet_pkey" PRIMARY KEY ("ad_set_id")
);

-- CreateTable
CREATE TABLE "MetaAd" (
    "ad_id" TEXT NOT NULL,
    "ad_set_id" TEXT NOT NULL,
    "ad_name" TEXT NOT NULL,
    "status" "MetaAdStatus" NOT NULL DEFAULT 'PAUSED',
    "creative" JSONB,
    "tracking" JSONB,
    "insights" JSONB,
    "effective_status" "MetaEffectiveStatus" DEFAULT 'PAUSED',
    "issues_info" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "data" JSONB,

    CONSTRAINT "MetaAd_pkey" PRIMARY KEY ("ad_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaCampaign_campaign_id_key" ON "MetaCampaign"("campaign_id");

-- CreateIndex
CREATE INDEX "MetaCampaign_ad_account_id_idx" ON "MetaCampaign"("ad_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdSet_ad_set_id_key" ON "MetaAdSet"("ad_set_id");

-- CreateIndex
CREATE INDEX "MetaAdSet_campaign_id_idx" ON "MetaAdSet"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAd_ad_id_key" ON "MetaAd"("ad_id");

-- CreateIndex
CREATE INDEX "MetaAd_ad_set_id_idx" ON "MetaAd"("ad_set_id");

-- AddForeignKey
ALTER TABLE "MetaCampaign" ADD CONSTRAINT "MetaCampaign_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "MarketingPlatform"("platform_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAdSet" ADD CONSTRAINT "MetaAdSet_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "MetaCampaign"("campaign_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAd" ADD CONSTRAINT "MetaAd_ad_set_id_fkey" FOREIGN KEY ("ad_set_id") REFERENCES "MetaAdSet"("ad_set_id") ON DELETE RESTRICT ON UPDATE CASCADE;
