// cch is a per-request nonce that kills prefix caching if it reaches the upstream prompt.
// Native relay and bridge converter must strip the billing header identically.
function isBillingHeaderSystemElement(system) {
  return typeof system === 'string' && system.trim().startsWith('x-anthropic-billing-header')
}

function removeBillingHeaderFromSystem(system) {
  if (typeof system === 'string') {
    return isBillingHeaderSystemElement(system) ? undefined : system
  }

  if (Array.isArray(system)) {
    return system.filter(
      (item) => !(item && item.type === 'text' && isBillingHeaderSystemElement(item.text))
    )
  }

  return system
}

module.exports = { removeBillingHeaderFromSystem }
