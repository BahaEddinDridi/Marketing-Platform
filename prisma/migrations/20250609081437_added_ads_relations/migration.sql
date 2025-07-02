-- CreateIndex
CREATE INDEX "MarketingCampaign_ad_account_id_idx" ON "MarketingCampaign"("ad_account_id");

-- CreateIndex
CREATE INDEX "MarketingCampaign_campaign_group_id_idx" ON "MarketingCampaign"("campaign_group_id");

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "AdAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_campaign_group_id_fkey" FOREIGN KEY ("campaign_group_id") REFERENCES "CampaignGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
