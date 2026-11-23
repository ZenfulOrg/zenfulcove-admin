import { NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/adminAuth";
import { getConfig } from "@/lib/kv";
import { getJervisProperties, resolveJervisPropertyId } from "@/lib/jervis";

// Read-only: shows which Jervis property each Lodgify unit resolves to, so a
// new or changed smart lock can be checked without creating a reservation.
const UNITS = [
  { propertyId: "608952", propertyName: "Fairy House" },
  { propertyId: "608953", propertyName: "Desert Rose" },
  { propertyId: "608954", propertyName: "Sky Castle" },
  { propertyId: "608955", propertyName: "Bird House" },
  { propertyId: "754651", propertyName: "Doodle House" },
];

export async function GET(request) {
  const unauthorized = await requireAdminRequest(request, { agentRead: true });
  if (unauthorized) return unauthorized;

  try {
    const config = (await getConfig()).accessCodeRelease || {};
    const properties = await getJervisProperties(config);
    const summary = (property) =>
      property
        ? {
            id: property.id,
            title: property.title,
            platformPropertyId: property.platform_property_id,
          }
        : null;

    const units = [];
    for (const unit of UNITS) {
      const { propertyId, source } = await resolveJervisPropertyId(unit, config);
      units.push({
        ...unit,
        jervisPropertyId: propertyId || null,
        matchedBy: source || null,
        jervisProperty: summary(
          properties.find((property) => String(property.id) === String(propertyId))
        ),
      });
    }

    return NextResponse.json({
      units,
      jervisProperties: properties.map(summary),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Jervis property check failed", details: err.message },
      { status: 500 }
    );
  }
}
