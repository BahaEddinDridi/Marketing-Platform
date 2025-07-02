-- CreateTable
CREATE TABLE "_LinkedInCampaignConfigToCampaignGroup" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_LinkedInCampaignConfigToCampaignGroup_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_LinkedInCampaignConfigToCampaignGroup_B_index" ON "_LinkedInCampaignConfigToCampaignGroup"("B");

-- AddForeignKey
ALTER TABLE "_LinkedInCampaignConfigToCampaignGroup" ADD CONSTRAINT "_LinkedInCampaignConfigToCampaignGroup_A_fkey" FOREIGN KEY ("A") REFERENCES "CampaignGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LinkedInCampaignConfigToCampaignGroup" ADD CONSTRAINT "_LinkedInCampaignConfigToCampaignGroup_B_fkey" FOREIGN KEY ("B") REFERENCES "LinkedInCampaignConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
