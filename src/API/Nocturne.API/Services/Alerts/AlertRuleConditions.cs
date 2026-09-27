using Nocturne.API.Services.Alerts.Evaluators;
using Nocturne.Core.Models;
using Nocturne.Core.Models.Alerts;

namespace Nocturne.API.Services.Alerts;

/// <summary>
/// The fields of a rule a tracker decision is made against and whose change clears the rule's
/// re-arm hold (docs/alerts/engine-semantics.md §6.3, <see cref="AlertRuleRearm"/>): its
/// enablement, condition and auto-resolve configuration. <see cref="ExcursionTransitionWriter"/>
/// drops a decision made against fields the rule no longer holds.
/// </summary>
internal readonly record struct AlertRuleConditions(
    bool IsEnabled,
    AlertConditionType ConditionType,
    string ConditionParams,
    bool AutoResolveEnabled,
    string? AutoResolveParams)
{
    /// <summary>The fields of an evaluated snapshot, which is loaded from the enabled rules only.</summary>
    public static AlertRuleConditions Of(AlertRuleSnapshot rule) =>
        new(true, rule.ConditionType, rule.ConditionParams, rule.AutoResolveEnabled, rule.AutoResolveParams);

    /// <summary>
    /// Whether <paramref name="rule"/> still holds these fields, its trees compared as JSON as a
    /// rule edit compares them (<see cref="ConditionTreeEquality"/>).
    /// </summary>
    public bool HeldBy(AlertRule? rule) =>
        rule is not null
        && rule.IsEnabled == IsEnabled
        && rule.ConditionType == ConditionType
        && rule.AutoResolveEnabled == AutoResolveEnabled
        && ConditionTreeEquality.Same(rule.ConditionParams, ConditionParams)
        && ConditionTreeEquality.Same(rule.AutoResolveParams, AutoResolveParams);
}
