/**
 * neat-runner.js
 * Runs a NEAT neural network forward pass in the browser.
 * Loads a model JSON exported from Python neat-python.
 */

const NEATRunner = (() => {

    // Activation functions — must match neat-python names
    const ACTIVATIONS = {
        sigmoid_activation: x => 1 / (1 + Math.exp(-4.9 * x)),
        tanh_activation: x => Math.tanh(x),
        relu_activation: x => Math.max(0, x),
        identity_activation: x => x,
        clamped_activation: x => Math.max(-1, Math.min(1, x)),
        abs_activation: x => Math.abs(x),
        gauss_activation: x => Math.exp(-5 * x * x),
        hat_activation: x => Math.max(0, 1 - Math.abs(x)),
        inv_activation: x => x === 0 ? 0 : 1 / x,
        log_activation: x => x > 0 ? Math.log(x) : 0,
        sin_activation: x => Math.sin(x),
        softplus_activation: x => Math.log(1 + Math.exp(x)),
        square_activation: x => x * x,
        cube_activation: x => x * x * x,
    };

    /**
     * Run a forward pass through a loaded NEAT model.
     * @param {Object} model - Parsed JSON from easy/medium/hard.json
     * @param {number[]} inputs - Array of 47 normalized floats
     * @returns {number[]} - Array of 5 output values
     */
    function activate(model, inputs) {
        // Build input map: input_keys are negative (-1 to -47), map to inputs[0..46]
        const values = {};
        model.input_keys.forEach((key, idx) => {
            values[key] = inputs[idx];
        });

        // Evaluate nodes in order (node_evals is already topologically sorted by neat-python)
        for (const node of model.node_evals) {
            let activation = ACTIVATIONS[node.activation];
            if (!activation) {
                console.warn(`Unknown activation: ${node.activation}, falling back to sigmoid`);
                activation = ACTIVATIONS.sigmoid_activation;
            }

            // Sum weighted inputs
            let s = node.bias;
            for (const [inputKey, weight] of node.links) {
                const val = values[inputKey];
                if (val !== undefined) {
                    s += val * weight;
                }
            }

            values[node.node] = activation(s * node.response);
        }

        // Collect outputs in order
        return model.output_keys.map(key => values[key] ?? 0);
    }

    /**
     * Load a model from a JSON file path.
     * @param {string} url - Path to model JSON
     * @returns {Promise<Object>} - Parsed model
     */
    async function loadModel(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load model: ${url}`);
        return await response.json();
    }

    return { activate, loadModel };
})();
