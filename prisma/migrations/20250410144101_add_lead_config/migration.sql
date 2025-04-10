-- CreateTable
CREATE TABLE "LeadConfiguration" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "filters" TEXT[] DEFAULT ARRAY['inquiry', 'interested', 'quote', 'sales', 'meeting']::TEXT[],
    "folders" JSONB NOT NULL DEFAULT '{"inbox": "Inbox", "junkemail": "Junk"}',
    "syncInterval" TEXT NOT NULL DEFAULT 'EVERY_HOUR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadConfiguration_orgId_key" ON "LeadConfiguration"("orgId");

-- AddForeignKey
ALTER TABLE "LeadConfiguration" ADD CONSTRAINT "LeadConfiguration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
