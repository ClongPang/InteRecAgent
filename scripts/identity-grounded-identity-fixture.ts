import { validateProductIdentitySnapshot, type ProductIdentitySnapshot } from "@interec/domain";

const registryVersion = 1;
const sourceRef = "identity-grounded-trajectory-fixture-v1";

export const trajectoryIdentitySnapshot: ProductIdentitySnapshot = validateProductIdentitySnapshot({
  schemaVersion: 1,
  registryVersion,
  checksum: sourceRef,
  brands: [
    { registryVersion, brandRef: "brand_apple", canonicalName: "Apple", aliases: ["Apple"], sourceRef },
    { registryVersion, brandRef: "brand_samsung", canonicalName: "Samsung", aliases: ["Samsung"], sourceRef },
    { registryVersion, brandRef: "brand_sony", canonicalName: "Sony", aliases: ["Sony"], sourceRef },
  ],
  products: [
    { registryVersion, productRef: "product_apple_airpods_max", brandRef: "brand_apple", canonicalName: "AirPods Max", productType: "headphones", sourceRef },
    { registryVersion, productRef: "product_samsung_s24", brandRef: "brand_samsung", canonicalName: "Galaxy S24", productType: "smartphone", sourceRef },
    { registryVersion, productRef: "product_sony_wh1000x", brandRef: "brand_sony", canonicalName: "WH-1000X", productType: "headphones", sourceRef },
  ],
  variants: [
    { registryVersion, variantRef: "variant_apple_a3184", productRef: "product_apple_airpods_max", canonicalModel: "A3184", attributes: { connector: "USB-C" }, status: "ACTIVE", sourceRef },
    { registryVersion, variantRef: "variant_samsung_sms921b_256gb", productRef: "product_samsung_s24", canonicalModel: "SM-S921B", attributes: { storage: "256GB" }, status: "ACTIVE", sourceRef },
    { registryVersion, variantRef: "variant_sony_wh1000xm4", productRef: "product_sony_wh1000x", canonicalModel: "WH-1000XM4", attributes: {}, status: "ACTIVE", sourceRef },
    { registryVersion, variantRef: "variant_sony_wh1000xm5", productRef: "product_sony_wh1000x", canonicalModel: "WH-1000XM5", attributes: {}, status: "ACTIVE", sourceRef },
  ],
  identifiers: [
    { registryVersion, identifierRef: "identifier_sony_xm4_gtin", variantRef: "variant_sony_wh1000xm4", brandRef: "brand_sony", scheme: "GTIN", normalizedValue: "5901234123457", approvalStatus: "APPROVED", sourceRef },
    { registryVersion, identifierRef: "identifier_sony_xm5_gtin", variantRef: "variant_sony_wh1000xm5", brandRef: "brand_sony", scheme: "GTIN", normalizedValue: "4006381333931", approvalStatus: "APPROVED", sourceRef },
  ],
  aliases: [
    { registryVersion, aliasRef: "alias_user_apple_a3184", variantRef: "variant_apple_a3184", purpose: "USER_INPUT", displayValue: "A3184", normalizedKey: "A3184", approvalStatus: "APPROVED", priority: 0, sourceRef },
    { registryVersion, aliasRef: "alias_provider_apple_a3184", variantRef: "variant_apple_a3184", purpose: "PROVIDER_QUERY", displayValue: "Apple AirPods Max USB-C A3184", normalizedKey: "APPLEAIRPODSMAXUSBCA3184", approvalStatus: "APPROVED", priority: 0, sourceRef },
    { registryVersion, aliasRef: "alias_user_samsung_sms921b", variantRef: "variant_samsung_sms921b_256gb", purpose: "USER_INPUT", displayValue: "SM-S921B 256GB", normalizedKey: "SMS921B256GB", approvalStatus: "APPROVED", priority: 0, sourceRef },
    { registryVersion, aliasRef: "alias_provider_samsung_sms921b", variantRef: "variant_samsung_sms921b_256gb", purpose: "PROVIDER_QUERY", displayValue: "Samsung Galaxy S24 SM-S921B 256GB", normalizedKey: "SAMSUNGGALAXYS24SMS921B256GB", approvalStatus: "APPROVED", priority: 0, sourceRef },
    { registryVersion, aliasRef: "alias_user_sony_wh1000xm4", variantRef: "variant_sony_wh1000xm4", purpose: "USER_INPUT", displayValue: "WH-1000XM4", normalizedKey: "WH1000XM4", approvalStatus: "APPROVED", priority: 0, sourceRef },
    { registryVersion, aliasRef: "alias_provider_sony_wh1000xm4", variantRef: "variant_sony_wh1000xm4", purpose: "PROVIDER_QUERY", displayValue: "Sony WH-1000XM4", normalizedKey: "SONYWH1000XM4", approvalStatus: "APPROVED", priority: 0, sourceRef },
    { registryVersion, aliasRef: "alias_user_sony_wh1000xm5", variantRef: "variant_sony_wh1000xm5", purpose: "USER_INPUT", displayValue: "WH-1000XM5", normalizedKey: "WH1000XM5", approvalStatus: "APPROVED", priority: 0, sourceRef },
    { registryVersion, aliasRef: "alias_user_sony_xm5", variantRef: "variant_sony_wh1000xm5", purpose: "USER_INPUT", displayValue: "XM5", normalizedKey: "XM5", approvalStatus: "APPROVED", priority: 10, sourceRef },
    { registryVersion, aliasRef: "alias_provider_sony_wh1000xm5", variantRef: "variant_sony_wh1000xm5", purpose: "PROVIDER_QUERY", displayValue: "Sony WH-1000XM5", normalizedKey: "SONYWH1000XM5", approvalStatus: "APPROVED", priority: 0, sourceRef },
  ],
  relationships: [
    { registryVersion, relationshipRef: "relationship_sony_xm5_successor_xm4", fromVariantRef: "variant_sony_wh1000xm5", toVariantRef: "variant_sony_wh1000xm4", kind: "SUCCESSOR_OF", sourceRef },
  ],
});
