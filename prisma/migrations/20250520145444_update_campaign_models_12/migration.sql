/*
  Warnings:

  - A unique constraint covering the columns `[external_id]` on the table `MarketingCampaign` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaign_external_id_key" ON "MarketingCampaign"("external_id");
