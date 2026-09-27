using System.Net;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Nocturne.Connectors.Core.Interfaces;
using Nocturne.Connectors.Core.Models;
using Nocturne.Connectors.Core.Services;
using Nocturne.Connectors.MyFitnessPal.Configurations;
using Nocturne.Connectors.MyFitnessPal.Services;
using Nocturne.Core.Contracts.Connectors;
using Nocturne.Core.Contracts.Multitenancy;
using Xunit;

namespace Nocturne.Connectors.MyFitnessPal.Tests.Services;

/// <summary>
///     What a MyFitnessPal sync that could not sign in tells the tenant. The token provider is the only
///     place that saw why, so its classification has to reach the result: a source that never
///     answered has no credential to fix.
/// </summary>
public class MyFitnessPalSignInFailureTests
{
    [Fact]
    public async Task Sync_WhenMyFitnessPalCannotBeReached_DoesNotBlameTheCredentials()
    {
        var result = await SyncWhenSignInThrows(new HttpRequestException("No such host is known"));

        result.Success.Should().BeFalse();
        result.Message.Should().Contain("usually temporary")
            .And.NotContain("password")
            .And.NotBe("Authentication failed");
        result.Errors.Should().ContainSingle().Which.Should().Be(result.Message);
    }

    [Fact]
    public async Task Sync_WhenMyFitnessPalRefusesTheSignIn_SendsTheTenantToTheirCredentials()
    {
        var result = await SyncWhenSignInThrows(
            new HttpRequestException("Unauthorized", null, HttpStatusCode.Unauthorized));

        result.Success.Should().BeFalse();
        result.Message.Should().Contain("did not accept this sign-in");
        result.Errors.Should().ContainSingle().Which.Should().Be(result.Message);
    }

    private static Task<SyncResult> SyncWhenSignInThrows(Exception failure)
    {
        var provider = new FailingSignInProvider(failure);
        var service = new MyFitnessPalConnectorService(
            new HttpClient(),
            new ConnectorServerResolver<MyFitnessPalConnectorConfiguration>(null, null, null),
            NullLogger<MyFitnessPalConnectorService>.Instance,
            Mock.Of<IRetryDelayStrategy>(),
            provider,
            Mock.Of<IConnectorConfigurationService>());

        return service.SyncDataAsync(
            new SyncRequest { DataTypes = [SyncDataType.Food] }, new MyFitnessPalConnectorConfiguration(), CancellationToken.None);
    }

    private static ITenantAccessor ResolvedTenant()
    {
        var tenant = new Mock<ITenantAccessor>();
        tenant.Setup(t => t.IsResolved).Returns(true);
        tenant.Setup(t => t.TenantId).Returns(Guid.NewGuid());
        return tenant.Object;
    }

    private sealed class FailingSignInProvider(Exception failure) : MyFitnessPalAuthTokenProvider(
        new HttpClient(),
        new ConnectorTokenCache(),
        new ConnectorServerResolver<MyFitnessPalConnectorConfiguration>(null, null, null),
        ResolvedTenant(),
        NullLogger<MyFitnessPalAuthTokenProvider>.Instance,
        Mock.Of<IRetryDelayStrategy>())
    {
        protected override async Task<(string? Token, DateTime ExpiresAt, IReadOnlyDictionary<string, string>? Metadata)> AcquireTokenAsync(
            MyFitnessPalConnectorConfiguration config, CancellationToken cancellationToken)
        {
            var token = await ExecuteWithRetryAsync<string>(
                _ => Task.FromException<(string?, bool)>(failure),
                Mock.Of<IRetryDelayStrategy>(),
                maxRetries: 2,
                "test sign-in",
                cancellationToken);
            return (token, DateTime.MinValue, null);
        }
    }
}
