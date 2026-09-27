using FluentAssertions;
using Nocturne.API.Helpers;

namespace Nocturne.API.Tests.Helpers;

public class NightscoutBaseUriTests
{
    [Theory]
    [InlineData("https://ns.example", "https://ns.example/")]
    [InlineData("https://ns.example/", "https://ns.example/")]
    [InlineData("https://ns.example/nightscout", "https://ns.example/nightscout/")]
    [InlineData("https://ns.example/nightscout/", "https://ns.example/nightscout/")]
    [InlineData("https://ns.example/a/b//", "https://ns.example/a/b/")]
    [InlineData("https://ns.example/?token=synthetic-token", "https://ns.example/")]
    [InlineData("https://ns.example/nightscout?token=synthetic-token#section", "https://ns.example/nightscout/")]
    [InlineData("https://user:pass@ns.example/nightscout", "https://ns.example/nightscout/")]
    [InlineData("http://ns.example:1337/nightscout", "http://ns.example:1337/nightscout/")]
    [InlineData("https://ns.example:443/nightscout", "https://ns.example/nightscout/")]
    [InlineData("https://ns.example/night%20scout", "https://ns.example/night%20scout/")]
    public void The_base_keeps_scheme_host_port_and_path_and_ends_in_one_slash(string configured, string expected)
    {
        NightscoutBaseUri.For(configured).AbsoluteUri.Should().Be(expected);
    }

    [Theory]
    [InlineData("https://ns.example", "/api/v1/entries.json?count=10", "https://ns.example/api/v1/entries.json?count=10")]
    [InlineData("https://ns.example/nightscout", "/api/v1/entries.json?count=10", "https://ns.example/nightscout/api/v1/entries.json?count=10")]
    [InlineData("https://ns.example/nightscout/", "api/v1/status", "https://ns.example/nightscout/api/v1/status")]
    [InlineData("https://ns.example/nightscout?token=synthetic-token", "/api/v1/status", "https://ns.example/nightscout/api/v1/status")]
    [InlineData("https://ns.example/nightscout", "//other.example/api/v1/status", "https://ns.example/nightscout/other.example/api/v1/status")]
    public void A_path_resolves_under_the_base_with_or_without_a_leading_slash(
        string configured, string pathAndQuery, string expected)
    {
        NightscoutBaseUri.Resolve(configured, pathAndQuery).AbsoluteUri.Should().Be(expected);
    }

    [Fact]
    public void A_relative_url_is_rejected()
    {
        var build = () => NightscoutBaseUri.For("ns.example/nightscout");

        build.Should().Throw<UriFormatException>();
    }
}
