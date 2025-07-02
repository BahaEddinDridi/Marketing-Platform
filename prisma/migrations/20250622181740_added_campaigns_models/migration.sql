/*
  Warnings:

  - You are about to drop the `CampaignPerformance` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "CampaignPerformance" DROP CONSTRAINT "CampaignPerformance_campaign_id_fkey";

-- DropTable
DROP TABLE "CampaignPerformance";

-- CreateTable
CREATE TABLE "AdAnalytics" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "dateFetched" TIMESTAMP(3) NOT NULL,
    "timeGranularity" TEXT NOT NULL,
    "datePeriodStart" TIMESTAMP(3) NOT NULL,
    "datePeriodEnd" TIMESTAMP(3) NOT NULL,
    "impressions" INTEGER,
    "clicks" INTEGER,
    "costInUsd" DOUBLE PRECISION,
    "conversions" INTEGER,
    "qualifiedLeads" INTEGER,
    "landingPageClicks" INTEGER,
    "costInLocalCurrency" DOUBLE PRECISION,
    "costPerQualifiedLead" DOUBLE PRECISION,
    "externalWebsiteConversions" INTEGER,
    "reactions" INTEGER,
    "shares" INTEGER,
    "follows" INTEGER,
    "videoViews" INTEGER,
    "videoCompletions" INTEGER,
    "comments" INTEGER,
    "averageDwellTime" DOUBLE PRECISION,
    "cardClicks" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignAnalytics" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "dateFetched" TIMESTAMP(3) NOT NULL,
    "timeGranularity" TEXT NOT NULL,
    "datePeriodStart" TIMESTAMP(3) NOT NULL,
    "datePeriodEnd" TIMESTAMP(3) NOT NULL,
    "impressions" INTEGER,
    "clicks" INTEGER,
    "costInUsd" DOUBLE PRECISION,
    "conversions" INTEGER,
    "qualifiedLeads" INTEGER,
    "revenueWonUsd" DOUBLE PRECISION,
    "returnOnAdSpend" DOUBLE PRECISION,
    "landingPageClicks" INTEGER,
    "costInLocalCurrency" DOUBLE PRECISION,
    "costPerQualifiedLead" DOUBLE PRECISION,
    "externalWebsiteConversions" INTEGER,
    "reactions" INTEGER,
    "shares" INTEGER,
    "follows" INTEGER,
    "videoViews" INTEGER,
    "videoCompletions" INTEGER,
    "comments" INTEGER,
    "averageDwellTime" DOUBLE PRECISION,
    "cardClicks" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdAnalytics_adId_datePeriodStart_datePeriodEnd_timeGranular_idx" ON "AdAnalytics"("adId", "datePeriodStart", "datePeriodEnd", "timeGranularity");

-- CreateIndex
CREATE INDEX "CampaignAnalytics_campaign_id_datePeriodStart_datePeriodEnd_idx" ON "CampaignAnalytics"("campaign_id", "datePeriodStart", "datePeriodEnd", "timeGranularity");

-- AddForeignKey
ALTER TABLE "AdAnalytics" ADD CONSTRAINT "AdAnalytics_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAnalytics" ADD CONSTRAINT "CampaignAnalytics_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "MarketingCampaign"("campaign_id") ON DELETE RESTRICT ON UPDATE CASCADE;
