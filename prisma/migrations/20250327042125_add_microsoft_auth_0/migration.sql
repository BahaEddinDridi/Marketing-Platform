/*
  Warnings:

  - Added the required column `user_id` to the `MarketingPlatform` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "MarketingPlatform" ADD COLUMN     "user_id" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "MarketingPlatform" ADD CONSTRAINT "MarketingPlatform_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
