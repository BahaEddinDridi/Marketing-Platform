-- DropForeignKey
ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_platform_id_fkey";

-- AlterTable
ALTER TABLE "Campaign" ALTER COLUMN "platform_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "MarketingPlatform"("platform_id") ON DELETE SET NULL ON UPDATE CASCADE;
