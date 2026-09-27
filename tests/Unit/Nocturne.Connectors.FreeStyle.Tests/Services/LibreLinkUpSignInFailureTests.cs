using System.Net;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Nocturne.Connectors.Core.Interfaces;
using Nocturne.Connectors.Core.Models;
using Nocturne.Connectors.Core.Services;
using Nocturne.Connectors.FreeStyle.Configurations;
using Nocturne.Connectors.FreeStyle.Services;
using Nocturne.Core.Contracts.Multitenancy;
using Xunit;

namespace Nocturne.Connectors.FreeStyle.Tests.Services;

/// <summary>
///     What a LibreLinkUp sync that could not sign in tells the tenant. The token provider is the only
///     place that saw why, so its classification has to reach the result: a source that never
///     answered has no credential to fix.
/// </summary>
public class LibreLinkUpSignInFailureTests
{
    [Fact]
    public async Task Sync_WhenLibreLinkUpCannotBeReached_DoesNotBlameTheCredentials()
    {
        var result = await SyncWhenSignInThrows(new HttpRequestException("No such host is known"));

        result.Success.Should().BeFalse();
        result.Message.Should().Contain("usually temporary")
            .And.NotContain("password")
            .And.NotBe("Authentication failed");
        result.Errors.Should().ContainSingle().Which.Should().Be(result.Message);
    }

    [Fact]
    public async Task Sync_WhenLibreLinkUpRefusesTheSignIn_SendsTheTenantToTheirCredentials()
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
        var service = new LibreConnectorService(
            new HttpClient(),
            new ConnectorServerResolver<LibreLinkUpConnectorConfiguration>(null, null, null),
            NullLogger<LibreConnectorService>.Instance,
            Mock.Of<IRetryDelayStrategy>(),
            Mock.Of<IRateLimitingStrategy>(),
            provider);

        return service.SyncDataAsync(
            new SyncRequest { DataTypes = [SyncDataType.Glucose] }, new LibreLinkUpConnectorConfiguration(), CancellationToken.None);
    }

    private static ITenantAccessor ResolvedTenant()
    {
        var tenant = new Mock<ITenantAccessor>();
        tenant.Setup(t => t.IsResolved).Returns(true);
        tenant.Setup(t => t.TenantId).Returns(Guid.NewGuid());
        return tenant.Object;
    }

    private sealed class FailingSignInProvider(Exception failure) : LibreLinkAuthTokenProvider(
        new HttpClient(),
        new ConnectorTokenCache(),
        new ConnectorServerResolver<LibreLinkUpConnectorConfiguration>(null, null, null),
        ResolvedTenant(),
        NullLogger<LibreLinkAuthTokenProvider>.Instance,
        Mock.Of<IRetryDelayStrategy>())
    {
        protected override async Task<(string? Token, DateTime ExpiresAt, IReadOnlyDictionary<string, string>? Metadata)> AcquireTokenAsync(
            LibreLinkUpConnectorConfiguration config, CancellationToken cancellationToken)
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
