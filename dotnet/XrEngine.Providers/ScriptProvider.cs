// XrEngine.Providers — C# ScriptProvider.
//
// Mirrors the TypeScript engine's ScriptProvider interface. In v1 this is a
// compile-verified .NET library: scene scripts as C# classes, created by name
// through the registry. Post-v1 the registry is hosted inside the engine
// process (Unity bridge or standalone host) and scripts drive live nodes.
using System;
using System.Collections.Generic;

namespace XrEngine.Providers;

/// <summary>Minimal node transform view handed to scripts. Mirrors the TS SceneNode fields scripts touch.</summary>
public sealed class ScriptNode
{
    public string Name { get; }
    public float X, Y, Z;             // position
    public float RX, RY, RZ, RW = 1;  // rotation quaternion
    public float SX = 1, SY = 1, SZ = 1;

    public ScriptNode(string name) { Name = name; }
}

/// <summary>Script contract. Mirrors TS `Script` (start/update).</summary>
public interface IEngineScript : IDisposable
{
    ScriptNode Node { get; set; }
    void Start();
    void Update(float dt, float t);
}

/// <summary>Convenient base class for engine scripts.</summary>
public abstract class EngineScript : IEngineScript
{
    public ScriptNode Node { get; set; } = new ScriptNode("unbound");
    public virtual void Start() { }
    public abstract void Update(float dt, float t);
    public virtual void Dispose() { }
}

/// <summary>Example: gentle bob + spin. Proves the C# scripting path works.</summary>
public sealed class FloatScript : EngineScript
{
    private float _t0;
    public float Amplitude { get; set; } = 0.25f;
    public float SpinSpeed { get; set; } = 0.6f;

    public override void Start() { _t0 = 0; }

    public override void Update(float dt, float t)
    {
        _t0 += dt;
        // Bob along Y.
        Node.Y += (float)Math.Sin(_t0 * 1.7) * Amplitude * dt * 4f;
        // Spin about Y: q = q * dq, dq = (0, sin(h), 0, cos(h)).
        float h = SpinSpeed * dt * 0.5f;
        float s = (float)Math.Sin(h), c = (float)Math.Cos(h);
        float x = Node.RX, y = Node.RY, z = Node.RZ, w = Node.RW;
        Node.RX = x * c - z * s;
        Node.RY = w * s + y * c;
        Node.RZ = x * s + z * c;
        Node.RW = w * c - y * s;
        _ = t;
    }
}

/// <summary>
/// ScriptProvider: creates IEngineScript instances by name.
/// This is the C# side of the engine's ScriptProvider seam.
/// </summary>
public sealed class ScriptProvider
{
    public const string LanguageTag = "C# (.NET)";

    private readonly Dictionary<string, Func<IEngineScript>> _registry = new(StringComparer.OrdinalIgnoreCase);

    public ScriptProvider()
    {
        Register("float", () => new FloatScript());
    }

    public void Register(string name, Func<IEngineScript> factory)
    {
        if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("name required", nameof(name));
        _registry[name] = factory ?? throw new ArgumentNullException(nameof(factory));
    }

    public IEngineScript Create(string name, ScriptNode node)
    {
        if (!_registry.TryGetValue(name, out var factory))
            throw new KeyNotFoundException($"No script registered as '{name}'.");
        var script = factory();
        script.Node = node;
        script.Start();
        return script;
    }

    public IEnumerable<string> RegisteredNames => _registry.Keys;
}
