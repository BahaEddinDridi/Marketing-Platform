/*
  Warnings:

  - You are about to drop the `_LinkedInCampaignConfigToCampaignGroup` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "_LinkedInCampaignConfigToCampaignGroup" DROP CONSTRAINT "_LinkedInCampaignConfigToCampaignGroup_A_fkey";

-- DropForeignKey
ALTER TABLE "_LinkedInCampaignConfigToCampaignGroup" DROP CONSTRAINT "_LinkedInCampaignConfigToCampaignGroup_B_fkey";

-- AlterTable
ALTER TABLE "LinkedInCampaignConfig" ALTER COLUMN "syncInterval" SET DEFAULT 'EVERY_60_MINUTES';

-- DropTable
DROP TABLE "_LinkedInCampaignConfigToCampaignGroup";
