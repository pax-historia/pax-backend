export function canUseAdmin(jwtClaims: Readonly<Record<string, unknown>>): boolean {
  return jwtClaims["admin"] === true || jwtClaims["role"] === "admin";
}

export function canUseCheats(jwtClaims: Readonly<Record<string, unknown>>): boolean {
  return canUseAdmin(jwtClaims) || jwtClaims["cheats"] === true;
}
