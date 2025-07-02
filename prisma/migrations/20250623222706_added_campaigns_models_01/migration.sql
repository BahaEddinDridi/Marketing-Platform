/*
  Warnings:

  - A unique constraint covering the columns `[campaign_id,datePeriodStart,datePeriodEnd,timeGranularity]` on the table `CampaignAnalytics` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "CampaignAnalytics_campaign_id_datePeriodStart_datePeriodEnd_key" ON "CampaignAnalytics"("campaign_id", "datePeriodStart", "datePeriodEnd", "timeGranularity");
