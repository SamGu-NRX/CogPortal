---
jupyter:
  jupytext:
    notebook_metadata_filter: nbsphinx,-kernelspec
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.14.0
  nbsphinx:
    execute: never
---

```python
from collections import defaultdict

import numpy as np

from mynn.layers.dense import dense
from mynn.optimizers.adam import Adam

from mygrad.nnet.losses import softmax_crossentropy
from mygrad.nnet.initializers import glorot_normal
from mygrad.nnet.activations import relu

import mygrad as mg

%matplotlib notebook
import matplotlib.pyplot as plt
```

# Seq2Seq Models


As we saw in the previous notebook, RNNs on their own are not well-suited to translation tasks, where word order may not necessarily align across languages.
In this notebook we will be introduced to "Sequence-to-Sequence", or Seq2Seq, models.
Seq2Seq models will leverage RNNs as a building block.

We will want to utilize the `generate_batch` function and `RNN` class from the previous notebook to create and train our Seq2Seq model.
Assuming you were able to complete the notebook, no modifications should need to be made to the code.

```python
def generate_batch(seq_len_min=1, seq_len_max=20, batch_size=10):
    """
    Generates a batch of sequences and corresponding one-hot encodings.
    
    Each digit-sequence has a length of T-1 (not including the <END> token),
    where the value for T-1 is randomly generated.
    
    Parameters
    ----------
    seq_len_min : int, optional (default=1)
       The smallest permissable length of the pattern,
       excluding start and end tokens
       
    seq_len_max : int, optional (default=20)
       The longest permissable length of the pattern,
       excluding start and end tokens
       
    batch_size : int, optional (default=10)
        The number of sequences to generate
    
    Returns
    -------
    Tuple[numpy.ndarray, numpy.ndarray, numpy.ndarray]
        1. the one-hot encoded sequences, including an end token; shape-(T, N, 12)
        2. the target sequences, including an end token; shape-(T, N)
        3. the original sequences of digits; shape-(T-1, N)
    """

    # Randomly generate a sequence length in [seq_len_min, seq_len_max]
    # This is the value T-1
    T_1 = np.random.randint(seq_len_min, seq_len_max + 1)  # <COGLINE>

    # Randomly generate the shape-(T-1, N) sequence of digits [0-9]. This
    # represents the N integer-valued sequences of length T-1 that our model
    # will be translating
    #
    # E.g. If T-1 = 3 and N = 2, this might produce:
    #
    #  array([[3, 9],
    #         [2, 5],
    #         [9, 3]])
    # seq-0: 3, 2, 9
    # seq-1: 9, 5, 3
    #
    # Assign this to the variable `digits`
    digits = np.random.randint(0, 10, (T_1, batch_size))  # <COGLINE>

    # Create an array of zeros to fill with one-hot encodings of sequences.
    # This should have a shape of (T, N, 12) and a dtype of float-32.
    #
    # The sequence length is T because the source sequence
    # needs to include the end token (but not start)
    #
    # Call this array `one_hot_x`
    one_hot_x = np.zeros((T_1 + 1, batch_size, 12), dtype=np.float32)  # <COGLINE>

    # Use `digits` to populate `one_hot_x` with the appropriate one-hot encodings.
    #
    # You can achieve this either via advanced indexing:
    # one_hot_x[np.arange(T_1).reshape(-1, 1), np.arange(batch_size), digits] = 1
    # 
    # Or by using a for-loop:
    # for ind in np.ndindex(digits.shape):
    #     one_hot_x[ind + (digits[ind],)] = 1
    # <COGINST>
    one_hot_x[np.arange(T_1).reshape(-1, 1), np.arange(batch_size), digits] = 1
    # </COGINST>

    # In `one_hot_x`, at the last token position for all batches, set the <END> token's one-hot encoding
    #
    # Hint: Recall that `one_hot_x` has a shape of (T, N, 12).
    # We want to access the T-th sequence entry and the 12th encoding position in this array
    # for all N batches using basic indexing. And we want to set all elements in this selected
    # subarray to 1.
    one_hot_x[-1, :, -1] = 1  # <COGLINE>

    # Create the "target" sequences, which are simply the reversed input sequences.
    # This should be a shape-(T, N) array, where the T-th row is filled with `11`, 
    # which is the <END> token.
    # <COGINST>
    ends = np.full(batch_size, 11).reshape(1, -1)
    y = np.concatenate([digits[::-1], ends], axis=0)
    # </COGINST>

    # Return the appropriate arrays - in accordance with the docstring.
    return one_hot_x, y, digits  # <COGLINE>
```

```python
class RNN:
    """Implements a simple-cell RNN that produces both outputs and hidden descriptors."""
    def __init__(self, dim_input, dim_recurrent, dim_output):
        """ Initializes all layers needed for RNN
        
        Parameters
        ----------
        dim_input: int 
            Dimensionality of data passed to RNN (C)
        
        dim_recurrent: int
            Dimensionality of hidden state in RNN (D)
        
        dim_output: int
            Dimensionality of output of RNN (K)
        """
        # <COGINST>
        self.fc_x2h = dense(dim_input, dim_recurrent, weight_initializer=glorot_normal)
        self.fc_h2h = dense(dim_recurrent, dim_recurrent, weight_initializer=glorot_normal, bias=False)
        self.fc_h2y = dense(dim_recurrent, dim_output, weight_initializer=glorot_normal)
        # </COGINST>
    
    
    def __call__(self, x, h=None):
        """ Performs the full forward pass for the RNN.
        
        Parameters
        ----------
        x: Union[numpy.ndarray, mygrad.Tensor], shape=(T, N, C)
            The one-hot encodings for the each sequence in the batch
        
        h: Optional[Union[numpy.ndarray, mygrad.Tensor]], shape=(1, N, D)
            An optional initial hidden dimension state h_0.
            If None, initialize an array of zeros.
        
        Returns
        -------
        Tuple[y, h]
            y: mygrad.Tensor, shape=(T, N, K)
                The final classification scores for each RNN step
            h: mygrad.Tensor, shape=(T, N, D)
                The hidden states computed at each RNN step, excluding the initial state h_0
        """
        # <COGINST>
        h_t = np.zeros((1, x.shape[1], self.fc_h2h.weight.shape[0]), dtype=np.float32) if h is None else h
        h = []
        
        for x_t in x:
            h_t = relu(self.fc_x2h(x_t[np.newaxis]) + self.fc_h2h(h_t))
            h.append(h_t)
        
        h = mg.concatenate(h, axis=0)
        
        return self.fc_h2y(h), h
        # </COGINST>
    
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model.
        
        This can be accessed as an attribute, via `model.parameters` 
        
        Returns
        -------
        Tuple[Tensor, ...]
            A tuple containing all of the learnable parameters for our model
        """
        return self.fc_x2h.parameters + self.fc_h2h.parameters + self.fc_h2y.parameters # <COGLINE>
```

Seq2Seq models follow an encoder-decoder structure, where one RNN encodes the original input sequence and a second RNN decodes the encoding to yield the final output.
By chaining together two RNNs in this way, we are able to first encode information about the input sequence as a whole, then parse that full-sequence-encoding when making the final predictions.




The encoding stage of Seq2Seq is quite simple - just run the original sequence through an RNN.
This will give us a set of predictions $(\vec{z}_t)$ and a set of hidden descriptors $(\vec{h}{}^e_t)$, as we are used to:

\begin{equation}
\big(\vec{z}_t\big)_{t=1}^T,\; \big(\vec{h}{}_t^e\big)_{t=1}^T- = \operatorname{RNN}_{\text{Encoder}}\big((\vec{x}_t)_{t=1}^T\big)
\end{equation}

The decoder is where our models starts to get more interesting, as we will use each prediction $\vec{y}_t$ as the subsequent decoder input $\vec{s}_{t+1}$.

First and foremost, in order to pass information from the encoder to the decoder, we will use the final encoder hidden descriptor as the initial decoder hidden descriptor:

\begin{equation}
\vec{h}{}^d_0 := \vec{h}{}^e_T
\end{equation}

Additionally, we will have the initial input to the decoder be a single start token:

\begin{equation}
\vec{s}_1 = \operatorname{One-Hot}\,(\langle\text{Start}\rangle)
\end{equation}

We do this to give the decoder some kind of starting point for every sequence that we want to generate.
We will run $\vec{s}_1$ and $\vec{h}{}^d_0$ through **a single step of the decoder**, which will then give us both prediction scores $\vec{y}_1$ and a new hidden descriptor $\vec{h}{}^d_1$:

\begin{equation}
\vec{y}_1,\; \vec{h}{}^d_1 = \operatorname{RNN}_{\text{Decoder}}\big(\vec{s}_1,\, \vec{h}{}^d_0\big) \\
\end{equation}

Now, we will determine the class with the largest prediction score in $\vec{y}_1$, and use a one-hot encoding for that class as the input to the next step of the decoder:

\begin{equation}
\vec{s}_2 = \operatorname{One-Hot}\,(\operatorname{arg\,max}(\vec{y}_1))
\end{equation}

For example, if our predicted scores $\vec{y}_1$ were `[0.32, 0.48, -0.12, 0.07]`, we would set $\vec{s}_2$ to be the one-hot encoding `[0, 1, 0, 0]`.
This process is known as "greedy decoding", as at each step we "greedily" take the best-scoring token to be the next input.

In general, our decoder will follow the update functions

\begin{align}
\vec{y}_t,\; \vec{h}{}^d_t &= \operatorname{RNN}_{\text{Decoder}}\big(\vec{s}_t,\, \vec{h}{}^d_{t-1}\big), \\
\vec{s}_{t+1} &= \operatorname{One-Hot}\,\big(\!\operatorname{arg\,max}\big(\vec{y}_t\big)\big),
\end{align}

for a total of $T$ steps.
Once $T$ predictions have been made, our final output from the model will be $\big(\vec{y}_t\big)_{t=1}^T$.
Note that we do not return the one-hot encodings that we used as the inputs $(\vec{s}_t)_{t=1}^T$.
We want to return all the classification scores so that the model can learn to raise the 'certainty' of the correct labels as it trains;
returning the one-hot encodings of the largest score would be percieved by the loss function as the model already having absolute confidence in all of its predictions!

It is also important to mention that, for more general NLP problems, we would stop the decoder from running once it yielded an end token, at which point we would return the prediction scores for only the subset of the sequence that we had processed.
However this would require us to process our truth values accordingly to handle the potential difference in sequence length between the model output and the truth values.
Thus for simplicity, we are always running the decoder for $T$ iterations, regardless of whether an end token appears before the final token or not.


Let's start by setting up the tools we will need to convert each decoder output into the next input.

Complete the function `one_hot_encode_prediction` below that takes in a Tensor of classification scores and returns a `float32` array of one-hot encodings for the classes with the largest prediction scores.
NumPy's `argmax` function will be particularly helpful here.

```python
def one_hot_encode_prediction(y_t):
    """ Converts a batch of classification scores y_t into one-hot
    encodings corresponding to the class with the largest score.
    
    Parameters
    ----------
    y_t: mygrad.Tensor, shape=(1, N, K)
        The predicted classification scores from one step of
        Seq2Seq decoding
    
    Returns
    -------
    s_t1: numpy.ndarray, shape=(1, N, K), dtype=np.float32
        One-hot encodings of the labels corresponding to
        the largest prediction scores in y_t. This should
        be a float32 NumPy array.
    
    Notes
    -----
    N denotes batch size
    K denotes the number of classes (i.e. the size of our vocabulary)
    """
    # <COGINST>
    y_t = y_t.data
    max_values_mask = (y_t == y_t.max(axis=-1, keepdims=True))
    
    return max_values_mask.astype(np.float32)
    # </COGINST>
```

Run the following cell to check your implementation.

```python
y_t = mg.random.randn(1, 4, 6)
s_t1 = one_hot_encode_prediction(y_t)

assert isinstance(s_t1, np.ndarray) # check if s_t1 is numpy array
assert issubclass(s_t1.dtype.type, np.float32) # check if s_t1 is float array
assert y_t.shape == s_t1.shape # check if s_t1 has correct shape
assert np.all(s_t1.sum(axis=-1) == np.ones((1, 4))) # check if one-hot encoded
assert np.all(np.argmax(y_t, axis=-1) == np.argmax(s_t1, axis=-1)) # check if correct one-hot encodings

print("Success!")
```

Now we'll write the `Seq2Seq` class.
Thankfully, between the `RNN` class and `one_hot_encode_prediction` function, we already have all the major pieces we need to do this!

```python
class Seq2Seq:
    def __init__(self, dim_input, dim_recurrent, dim_output):
        """ Initializes all RNN layers needed for Seq2Seq
        
        Parameters
        ----------
        dim_input: int 
            Dimensionality of data passed to Seq2Seq (C)
        
        dim_recurrent: int
            Dimensionality of hidden state in RNN layers (D)
        
        dim_output: int
            Dimensionality of output of Seq2Seq (K)
        
        Notes
        -----
        For this particular problem, the input dimension and
        output dimension will be the same (C = K). In general,
        however, this may not be the case.
        """
        # Instantiate two RNNs - an encoder and a decoder.
        # Both should use all of `dim_input`,
        # `dim_recurrent`, and `dim_output`.
        # <COGINST>
        self.encoder = RNN(dim_input, dim_recurrent, dim_output)
        self.decoder = RNN(dim_input, dim_recurrent, dim_output)
        # </COGINST>
    
    def __call__(self, x):
        """ Performs the full forward pass (encoding and decoding) for Seq2Seq.
        
        Parameters
        ----------
        x: Union[numpy.ndarray, mygrad.Tensor], shape=(T, N, C)
            The one-hot encodings for the each sequence in the batch
        
        Returns
        -------
        y: mygrad.Tensor, shape=(T, N, K)
            The final classification scores from the output of each decoder step
        """
        # Run the input sequence through the encoder RNN.
        # Save the hidden states to the variable `enc_h`.
        # The hidden states will have shape (T, N, D)
        # <COGINST>
        T, N, C = x.shape
        _, enc_h = self.encoder(x)  # enc_h: shape-(T, N, D)
        # </COGINST>
        
        
        # Access the last hidden descriptor from `enc_h`
        # to be used as the initial h_{-1} for the decoder.
        # Make sure to preserve the dimensions, such that
        # the shape of this hidden descriptor is (1, N, D)
        # <COGINST>
        h_t = enc_h[-1:]  # h_t: shape-(1, N, D)
        # </COGINST>
        
        # Create a list `y` to store the prediction scores y_t
        y = [] # <COGLINE>
        
        # Create the initial input to the decoder:
        # a float32 array with shape (1, N, C) representing
        # a one-hot encoding for the <START> token
        # (which we represented as a 10).
        # <COGINST>
        s_t = np.zeros((1, N, C), dtype=np.float32)
        s_t[..., -2] = 1
        # </COGINST>
        
        # Iteratively produce new y_t, h_t from the decoder.
        # Store each y_t in the list `y`.
        # Using `one_hot_encode_prediction`, get the next
        # decoder input s_{t+1} from the output y_t.
        #
        # A standard for-loop is appropriate here.
        # <COGINST>
        for _ in range(T):
            # y_t: shape-(1, N, K)
            # h_t: shape-(1, N, D)
            y_t, h_t = self.decoder(s_t, h_t)
            y.append(y_t)
            
            # use best prediction as next input to decoder
            s_t = one_hot_encode_prediction(y_t)
        # </COGINST>
        
        # Concatenate the y_t Tensors stored in `y` along the 0-th axis.
        # Return the result.
        # <COGINST>
        y = mg.concatenate(y, axis=0)  # y: shape-(T, N, K)
        return y
        # </COGINST>
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model.
        
        This can be accessed as an attribute, via `model.parameters` 
        
        Returns
        -------
        Tuple[Tensor, ...]
            A tuple containing all of the learnable parameters for our model
        """
        return self.encoder.parameters + self.decoder.parameters # <COGLINE>
```

Create a noggin plot to track loss and accuracy below.

```python
from noggin import create_plot
plotter, fig, ax = create_plot(["loss", "accuracy"]) # <COGLINE>
```

Instantiate a `Seq2Seq` model and `Adam` optimizer.
Adam's default parameters are a good starting place, as is a `recurrent_dim` of $50$.

```python
# <COGINST>
model = Seq2Seq(dim_input=12, dim_recurrent=50, dim_output=12)
optimizer = Adam(model.parameters)
# </COGINST>
```

Write your training loop below, using `softmax_crossentropy` to compute loss.
As with the basic `RNN`, make sure to reshape the output of the model and the target labels appropriately to match the shapes the function expects.
Train your model for $10000$ iterations, with a batch size of $100$ and sequence lengths ranging from $1$ to $20$.

```python
# <COGINST>
batch_size=100

for k in range(10000):
    x, target, sequence = generate_batch(batch_size=batch_size)

    output = model(x)
    
    loss = softmax_crossentropy(output.reshape(-1, 12), target.reshape(-1))
    loss.backward()
    optimizer.step()
    
    acc = np.mean(np.argmax(output, axis=-1) == target)

    plotter.set_train_batch({"loss":loss.item(), "accuracy":acc}, batch_size=batch_size)
    
    if k % 500 == 0 and k > 0:
        plotter.set_train_epoch()

plotter.plot()
# </COGINST>
```

Run the cell below to evaluate your model's accuracy on sequences of varying lengths.
How does the Seq2Seq model compare to the basic RNN?
Does anything surprise you, and if not, why do you expect these results?
Discuss your thoughts with a neighbor.

```python
length_total = defaultdict(int)
length_correct = defaultdict(int)

with mg.no_autodiff:
    for i in range(50000):
        if i % 5000 == 0:
            print(f"i = {i}")
        x, target, sequence = generate_batch(1, 20, 1)

        output = model(x)

        length_total[sequence.size] += 1
        if np.all(np.argmax(output, axis=-1) == target):
            length_correct[sequence.size] += 1

fig, ax = plt.subplots()
x, y = [], []
for i in range(1, 20):
    x.append(i)
    y.append(length_correct[i] / length_total[i])
ax.plot(x, y);
ax.set_xlabel("Sequence Length")
ax.set_ylabel("Model Accuracy")
ax.grid()
```

# Attention


Compared to our first attempt at reversing sequences with RNNs, the Seq2Seq model seems to be a great success!
Unfortunately, it still has a hard time learning to reverse longer sequences.
Why might this be?

Well, in RNNs, information about tokens is passed through the hidden state.
The encoder shares its final hidden descriptor with the decoder, thus giving the decoder information about the original sequence as it computes the final outputs.
However, the hidden state is iteratively updated as new information is recieved by the encoder and decoder.
This means that information from the beginning of the sequence will gradually disappear over time.
In fact for a length-$20$ sequence, information about the first digit $x_{t=0}$ would need to be saved through $40$ hidden state updates before the decoder needed it!

To help the model learn these long-term relations, we can introduce a **attention** mechanism.

In short, an attention mechanism allows the Seq2Seq model to look at all the encoder hidden descriptors and weight them according to importance during each decoder step.
These weights are learned by the model during training, and allow the model to determine which encoder hidden descriptors are most relevant to the current decoding step, even if that descriptor was very far away!
Thus each decoder descriptor will be enhanced with the most relevant (as learned by the model) parts of the encoder's hidden state.


### Attention Scores and Weights and Context Vectors, Oh My


We will begin by computing **attention scores** between the each of the encoder's hidden states and the current decoder hidden descriptor.

At each decoder step $t$, we will have access to the $D$-dimensional decoder hidden descriptor, $\vec{h}{}^d_t$. We will also have the $(T,D)$ matrix containing all $T$ of the $D$-dimensional encoder hidden descriptors, $H^e$:

\begin{align}
&\:\begin{matrix}\xleftarrow{\hspace{0.75em}} & D & \xrightarrow{\hspace{0.75em}}\end{matrix} \\
H^e =\;\, &\begin{bmatrix}\leftarrow & \vec{h}{}^e_1 & \rightarrow \\ \leftarrow & \vec{h}{}^e_2 & \rightarrow \\ \vdots & \vdots & \vdots \\ \leftarrow & \vec{h}{}^e_T & \rightarrow\end{bmatrix}\;\;\begin{matrix}\bigg\uparrow \\ T \\ \bigg\downarrow\end{matrix}
\end{align}

Here each row in this matrix is a distinct hidden descriptor from the encoder RNN. We will also define a $(D,D)$ matrix of learnable parameters $W_\alpha$,

\begin{align}
&\;\begin{matrix}\xleftarrow{\hspace{2.25em}} & D & \xrightarrow{\hspace{2.25em}}\end{matrix} \\
W_\alpha =\;\, &\begin{bmatrix}\uparrow & \uparrow & \cdots & \uparrow \\ \vec{W}_1 & \vec{W}_2 & \cdots & \vec{W}_D \\ \downarrow & \downarrow & \cdots & \downarrow\end{bmatrix}\;\;\begin{matrix}\big\uparrow \\ D \\ \big\downarrow\end{matrix}
\end{align}

where we can think about each column as a distinct $D$-dimensional weight vector. Using these, we will compute attention scores between the current decoder hidden descriptor and each of the encoder hidden states as

\begin{equation}
\vec{e}_t = H^e W_\alpha \vec{h}{}^d_t
\end{equation}

**Here** $\vec{e}_t$ **is an augmented form of the decoder hidden descriptor at timestep** $t$ $\big($i.e. $\vec{h}{}^d_t\big)$;
**each component of this descriptor has been enhanced by the most relevant parts of all of the encoder's hidden descriptors** (where what constitutes 'relevant' is learned by the model during training).


Let's expand this out and take a moment to see how $\vec{e}_t$ gets us this modified decoder hidden state.
We can start with the $H^eW_\alpha$ matrix multiplication;
if we consider each of the $D$ columns of $W_\alpha$ to be a $D$-dimensional weight vector, then this matrix multiplication is computing dot products between each encoder hidden state and each column vector in the weight matrix.

\begin{align}
&\;\begin{matrix}\xleftarrow{\hspace{4.75em}} & D & \xrightarrow{\hspace{4.75em}}\end{matrix} \\
H^eW_\alpha =\;\, &\begin{bmatrix}\vec{h}{}^e_1\cdot\vec{W}_1 & \vec{h}{}^e_1\cdot\vec{W}_2 & \cdots & \vec{h}{}^e_1\cdot\vec{W}_D \\ \vec{h}{}^e_2\cdot\vec{W}_1 & \vec{h}{}^e_2\cdot\vec{W}_2 & \cdots & \vec{h}^e_2\cdot\vec{W}_D \\ \vdots & \vdots & \ddots & \vdots \\ \vec{h}{}^e_T\cdot\vec{W}_1 & \vec{h}{}^e_T\cdot\vec{W}_2 & \cdots & \vec{h}{}^e_T\cdot\vec{W}_D\end{bmatrix}\;\;\begin{matrix}\bigg\uparrow \\ T \\ \bigg\downarrow\end{matrix}
\end{align}

So each value in the $H^eW_\alpha$ matrix represents a similarity between an encoder hidden state and a weight vector.
We then matrix multiply with the decoder's hidden state vector, thus weighting the components of the decoder hidden state by the 'similarity scores' computed between each weight vector and each encoder hidden state.

\begin{align}
&\begin{bmatrix}
\hspace{2.3em} (h^d_t)_1 \hspace{2.3em}\vphantom{\vec{h}} \\
\hspace{2.3em} (h^d_t)_2 \hspace{2.3em}\vphantom{\vec{h}} \\
\vdots \\
\hspace{2.3em} (h^d_t)_D \hspace{2.3em}\vphantom{\vec{h}}
\end{bmatrix} \\
%
\vec{e}_t = H^eW_\alpha\vec{h}{}^d_t =
\begin{bmatrix}
\vec{h}{}^e_1\cdot\vec{W}_1 \vphantom{\sum\limits_{i=1}^D}
    & \vec{h}{}^e_1\cdot\vec{W}_2
    & \cdots 
    & \vec{h}{}^e_1\cdot\vec{W}_D \\
\vec{h}{}^e_2\cdot\vec{W}_1 \vphantom{\sum\limits_{i=1}^D}
    & \vec{h}{}^e_2\cdot\vec{W}_2
    & \cdots
    & \vec{h}{}^e_2\cdot\vec{W}_D \\
\vdots
    & \vdots
    & \ddots
    & \vdots \\
\vec{h}{}^e_T\cdot\vec{W}_1 \vphantom{\sum\limits_{i=1}^D}
    & \vec{h}{}^e_T\cdot\vec{W}_2
    & \cdots
    & \vec{h}{}^e_T\cdot\vec{W}_D
\end{bmatrix}
%
&\begin{bmatrix}
\sum\limits_{i=1}^D\big(\vec{h}{}^e_1\cdot\vec{W}_i\big)(h^d_t)_i \\
\sum\limits_{i=1}^D\big(\vec{h}{}^e_2\cdot\vec{W}_i\big)(h^d_t)_i \\
\vdots \\
\sum\limits_{i=1}^D\big(\vec{h}{}^e_T\cdot\vec{W}_i\big)(h^d_t)_i
\end{bmatrix} =
%
\begin{bmatrix}
e_{t,1} \vphantom{\sum\limits_{i=1}^D} \\ 
e_{t,2} \vphantom{\sum\limits_{i=1}^D} \\ 
\vdots \\ 
e_{t,T} \vphantom{\sum\limits_{i=1}^D}
\end{bmatrix}
\end{align}

As the model trains, the $i^\text{th}$ weight vector will be tuned to extract meaningful information from all of the encoder hidden descriptors that is relevant specifically to the $i^\text{th}$ component of the decoder hidden state.
If an encoder hidden state consistently has information that is particularly relevant to a component of the decoder hidden state, the weight vectors will learn this pattern and amplify it in the final attention score.

The matrix of learnable weights thus allows the model to learn more complex contextual relationships between the hidden descriptors of the encoder and those of the decoder.
Notice that if $W_\alpha$ were the identity matrix, we would actually be calculating the dot products between the decoder hidden descriptor $\vec{h}{}^d_t$ and each of the encoder hidden states.
Thus the attention score defined above can be thought of as a weighted dot product, and hence will retain similar vector-overlap computing abilities along with additional learned weightings;
just as dot products measure the overlap between two vectors, _we can think of these attention scores as a measure of how similar, or 'relevant', the encoder hidden descriptor is to the decoder hidden state_.

<!-- #region -->
Conveniently enough, our `RNN` class will return an exactly the tensor we need containing all of the hidden states!
This means we only need to define a MyNN `dense` for $W_\alpha$, and we'll be able to start computing the attention scores.
We will want to precompute the $H^eW_\alpha$ right after we get the output of the encoder, before running any decoder steps:

```python
precomputed_encoder_score_vectors = W_alpha(encoder_hidden_states)
# (T, N, D) @ (D, D) -> (T, N, D)
```

Doing this means we will only compute these values once, as opposed to recomputing each time we call the decoder.
During each decoder step, we can compute the final attention score vector by taking a dot product:

```python
e_t = (precomputed_encoder_score_vectors * h_t).sum(axis=-1)
# (T, N, D) * (1, N, D) -> (T, N, D).sum(axis=-1) -> (T, N)
```

Here, the $i^\text{th}$ row corresponds to the attention score $e_{t,i}$ between the current decoder hidden descriptor $\vec{h}{}^d_t$, and the $i^\text{th}$ encoder hidden state.
<!-- #endregion -->

<!-- #region -->
With this vector of attention scores, we can calculate the **attention weights** for the decoder hidden descriptor.
Intuitively, a higher weight will tell the model: "for the current decoder step, it is important to pay more attention to this particular encoder hidden state than the other hidden states".
A lower weight will tell the model: "for the current decoder step, it is ok to mostly ignore the information contained within this particular encoder hidden state".
In this way, the model is learning to ascribe an importance of each encoder hidden state to the decoder hidden descriptor.

The attention scores for the current decoder hidden descriptor are computed by taking the softmax of the attention scores,

\begin{equation}
\vec{\alpha}_t = \operatorname{softmax}(\vec{e}_t) = \frac{\exp(\vec{e}_t)}{\sum_{i=1}^T\exp(e_{t,i})} = \frac{\exp(\vec{e}_t)}{\exp(e_{t,1}) + \exp(e_{t,2}) + \cdots + \exp(e_{t,T})}.
\end{equation}

Since MyGrad has a `softmax` function built-in, we can simply apply it to our attention scores, taking care to take the softmax over the dimension corresponding to the $T$ attention scores:

```python
a_t = mg.nnet.softmax(e_t, axis=0)
# softmax((T, N), axis=0) -> (T, N)
```
<!-- #endregion -->

<!-- #region -->
Finally, we will use our attention weights to compute a **context vector** that 'summarizes' the information from all the encoder hidden states.
We do this by taking a weighted sum of the encoder hidden states, where the coefficients of the hiddens states are the previously computed attention weights!

\begin{equation}
\vec{c}_t = \sum_{j=1}^T \alpha_{j}\vec{h}{}^e_j = \alpha_{1}\big(\vec{h}{}^e_1\big) + \alpha_{2}\big(\vec{h}{}^e_2\big) + \cdots + \alpha_{T}\big(\vec{h}{}^e_T\big)
\end{equation}

Since less relevant encoder hidden states are given lower attention weights, the context vector $\vec{c}_t$ will primarily contain information from the most relevant hidden states.
In our implementation, since our batch dimension is the $1^\text{st}$ axis, we will need to take care to sum along the axis corresponding to the sequence length:

```python
c_t = (a_t[..., None] * encoder_hidden_states).sum(axis=0, keepdims=True)
# (T, N, 1) * (T, N, D) -> (T, N, D).sum(axis=0, keepdims=True) -> (1, N, D)
```
<!-- #endregion -->

<!-- #region -->
Well so far this is great and all, but what are we supposed to do with the context vector now?
That is, how do we incorporate the context vector into the output from the decoder RNN?

There are a number of ways that machine learning researchers have done this;
the approach we will take will have us concatenate the context vector $\vec{c}_t$ to the output $\vec{y}_t$ of the normal decoder step.


That is, we will compute the decoder step as normal, using $\vec{s}_t$ and $\vec{h}{}^d_t$, to get $\vec{y}_t$ and $\vec{h}{}^d_t$.
However, before we store $\vec{y}_t$ and use it to determine the next decoder input $\vec{s}_{t+1}$, we will concatenate $\vec{y}_t$ and the context vector $\vec{c}_t$.


```python
y_and_c = mg.concatenate([y_t, c_t], axis=-1)
# concatenate([(1, N, K), (1, N, D)], axis=-1) -> (1, N, K + D)
```

Since we change the dimensionality of the output vector, we will need to apply a dense layer to correct the output dimensionality and recompute the final classification scores.

```python
y_t = post_concat_dense(y_and_c)
# (1, N, K + D) @ (K + D, K) -> (1, N, K)
```

And that's that!
The final dense layer acts as a sort of interpreter, integrating the information carried in the context vector with that in the decoder output.
Thus our final output for each decoder step has contained in it information directly taken from the most important encoder hidden states!
If there is a long-term dependency in the source and target sequences, the output vector should be able to pick up on it!
<!-- #endregion -->

Let's finally put this all to work.

In the class below, augment your previous Seq2Seq models with the attention mechanism described above.
On each decoder step, save the computed attention weights.
In `__call__`, return both the predicted scores and a $(T,\, T,\, N)$ array of attention weights, whose $0^\text{th}$ dimension corresponds to the attention weights for each decoder step.

```python
class AttentionSeq2Seq:
    def __init__(self, dim_input, dim_recurrent, dim_output):
        """ Initializes all RNN layers needed for Seq2Seq
        
        Parameters
        ----------
        dim_input: int 
            Dimensionality of data passed to Seq2Seq (C)
        
        dim_recurrent: int
            Dimensionality of hidden state in RNN layers (D)
        
        dim_output: int
            Dimensionality of output of Seq2Seq (K)
        
        Notes
        -----
        For this particular problem, the input dimension and
        output dimension will be the same (C = K). In general,
        however, this may not be the case.
        """
        # Instantiate two RNNs, an encoder and a decoder, as done before.
        #
        # Then, instantiate two MyNN dense layers:
        # - one corresponding to the (D, D) matrix W_alpha (with no bias),
        # - one to take the concat-ed y_t and c_t vector (dim K+D)
        #   to a vector with the appropriate output dimension (dim K).
        #
        # Use a glorot_normal weight initializer for 
        # both of these dense layers.
        # <COGINST>
        self.encoder = RNN(dim_input, dim_recurrent, dim_output)
        self.decoder = RNN(dim_input, dim_recurrent, dim_output)
        
        self.W_alpha = dense(dim_recurrent, dim_recurrent, weight_initializer=glorot_normal, bias=False)
        self.post_concat_dense = dense(dim_recurrent + dim_output, dim_output, weight_initializer=glorot_normal)
        # </COGINST>
    
    def __call__(self, x):
        """ Performs the full forward pass (encoding and decoding) for Seq2Seq.
        
        Parameters
        ----------
        x: Union[numpy.ndarray, mygrad.Tensor], shape=(T, N, C)
            The one-hot encodings for the each sequence in the batch
        
        Returns
        -------
        y: mygrad.Tensor, shape=(T, N, K)
            The final classification scores from the output of each decoder step
        a_ij: numpy.array, shape=(T, T, N)
            The computed attention weights for the batch of sequences. The 0-th
            dimension corresponds to the attention weights computed at each
            decoder step
        """
        # Perform the same encoding and decoder setup as
        # in the `Seq2Seq` model. That is:
        #
        # - get the encoder hidden states `enc_h`,
        # - set the initial decoder hidden state to the
        #   last encoder hidden state
        # - create a list `y` to store the decoder outputs
        # - initialize a <START> token one-hot encoding
        #   as the intial decoder input
        # <COGINST>
        T, N, C = x.shape
        _, enc_h = self.encoder(x) # enc_h: shape-(T, N, D)
        
        h_t = enc_h[-1:] # h_t: shape-(1, N, D)
        y = []
        
        s_t = np.zeros((1, N, C), dtype=np.float32)
        s_t[..., -2] = 1
        # </COGINST>
        
        # Apply the dense layer corresponding to W_alpha
        # to `enc_h` to precompute part of the attention scores
        # <COGINST>
        attn_score_precomputed = self.W_alpha(enc_h) # context: shape-(T, N, D)
        # </COGINST>
        
        # This create a list `a_ij` to store the
        # attention weights at each decoder step.
        a_ij = []
        
        for _ in range(T):
            # Compute the attention scores `e_t` for
            # the current decoder hidden state using the
            # precomputed W_alpha * H^e.
            # <COGINST>
            e_t = (h_t * attn_score_precomputed).sum(axis=-1) # e_t: shape-(T, N)
            # </COGINST>
            
            # Take the softmax of the attention scores to
            # compute the attention weights. Make sure to take
            # the softmax over the `T` dimension.
            #
            # Store the result in the variable `a_t`.
            # <COGINST>
            a_t = mg.nnet.softmax(e_t, axis=0) # a_t: shape-(T, N)
            # </COGINST>
            
            # This appends the attention weights for the current
            # decoder step to the `a_ij` list. The new axis is to
            # allow the weights to be concatenated into a single matrix.
            a_ij.append(a_t.data[None])
            
            # Compute the context vector `c_t` from the encoder hidden states
            # `enc_h` and the attention weights `a_t`.
            # <COGINST>
            c_t = (enc_h * a_t[..., None]).sum(axis=0, keepdims=True) # c_t: shape-(1, N, D)
            # </COGINST>
            
            # As in the basic Seq2Seq model, perform one decoder step to
            # get y_t and h_t.
            # <COGINST>
            # y_t: shape-(1, N, K)
            # h_t: shape-(1, N, D)
            y_t, h_t = self.decoder(s_t, h_t)
            # </COGINST>
            
            # Concatenate the decoder output y_t and the context
            # vector c_t along the last axis.
            # <COGINST>
            y_t = mg.concatenate([y_t, c_t], axis=-1) # y_t: shape-(1, N, K + D)
            # </COGINST>
            
            # Apply a dense layer to compress the concatenated vectors
            # into a vector with the appropriate output dimensionality (K).
            # Append this final `y_t` to the list `y`.
            # <COGINST>
            y_t = self.post_concat_dense(y_t) # y_t: shape-(1, N, K)
            y.append(y_t)
            # </COGINST>
            
            # Use `one_hot_encode_prediction` to find the
            # next decoder input s_{t+1} based on the now-combined
            # decoder output and context vector `y_t`.
            # <COGINST>
            s_t = one_hot_encode_prediction(y_t) # s_t: shape-(1, N, K)
            # </COGINST>
        
        # Concatenate the y_t Tensors stored in `y` along the 0-th axis.
        # <COGINST>
        y = mg.concatenate(y, axis=0) # y: shape-(T, N, K)
        # </COGINST>
        
        # This concatenates the T attention vectors `a_t` that
        # were computed for each decoder step (along the 0-th axis).
        a_ij = np.concatenate(a_ij, axis=0) # a_ij: shape-(T, T, N)
        
        # Return the appropriate tensors and arrays - in accordance with the docstring.
        return y, a_ij # <COGLINE>
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model.
        
        This can be accessed as an attribute, via `model.parameters`
        
        Returns
        -------
        Tuple[Tensor, ...]
            A tuple containing all of the learnable parameters for our model
        """
        # <COGINST>
        return (self.encoder.parameters + self.decoder.parameters
                + self.post_concat_dense.parameters + self.W_alpha.parameters)
        # </COGINST>
```

Instatiate a noggin plot here to keep track of the loss and accuracy of the model as it trains.

```python
from noggin import create_plot
plotter, fig, ax = create_plot(["loss", "accuracy"]) # <COGLINE>
```

Instatiate an `AttentionSeq2Seq` model and an `Adam` optimizer.
For the model, a `dim_recurrent` of $25$ is a good choice.
For the optimizer, the default parameters are a good starting place.

```python
# <COGINST>
model = AttentionSeq2Seq(dim_input=12, dim_recurrent=25, dim_output=12)
optimizer = Adam(model.parameters)
# </COGINST>
```

Write the training loop below.
Use a batch size of $100$ with sequence lengths between $1$ and $20$.
Train your model for $8000$ iterations.

```python
# <COGINST>
batch_size=100

for k in range(8000):
    x, target, sequence = generate_batch(batch_size=batch_size)

    output, _ = model(x)
    
    loss = softmax_crossentropy(output.reshape(-1, 12), target.reshape(-1))
    loss.backward()
    optimizer.step()
    
    acc = np.mean(np.argmax(output, axis=-1) == target)

    plotter.set_train_batch({"loss":loss.item(), "accuracy":acc}, batch_size=batch_size)
    
    if k % 500 == 0 and k > 0:
        plotter.set_train_epoch()

plotter.plot()
# </COGINST>
```

Run the following to evaluate the accuracy of your model

```python
length_total = defaultdict(int)
length_correct = defaultdict(int)

with mg.no_autodiff:
    for i in range(50000):
        if i % 5000 == 0:
            print(f"i = {i}")
        x, target, sequence = generate_batch(1, 20, 1)

        output, _ = model(x)

        length_total[sequence.size] += 1
        if np.all(np.argmax(output, axis=-1) == target):
            length_correct[sequence.size] += 1

fig, ax = plt.subplots()
x, y = [], []
for i in range(1, 20):
    x.append(i)
    y.append(length_correct[i] / length_total[i])
ax.plot(x, y);
```

Awesome!
We can see perfect or near-perfect accuracy for all the sequence lengths we trained on (if trained long enough, the model will be able to completely master this problem)!

Let's finish up by taking a look at the attention weights computed for a single sequence.
Run the cell below to visualize the attention weights for a sequence length of your choosing.

```python
seq_len = 15

x, target, sequence = generate_batch(seq_len, seq_len, 1)
y, a_ij = model(x)
y = np.argmax(y, axis=-1).squeeze() # determine decoder inputs

fig, ax = plt.subplots()

ax.set_yticks(range(y.size))
ax.set_yticklabels(["<S>"] + [x for x in y[:-1]])
ax.set_ylabel("Input to Decoder")

ax.xaxis.tick_top()
ax.xaxis.set_label_position('top') 

ax.set_xticks(range(target.size))
ax.set_xticklabels([x for x in sequence.squeeze()] + ["<E>"])
ax.set_xlabel("Original Sequence")

ax.imshow(a_ij.squeeze());
```

Did you expect to see these results?
Do they make intuitive sense, given the problem we are trying to solve?

The introduction of attention was a significant step forward in understandability in deep learning, where oftentimes the high-dimensional, highly-nonlinear functions that get learned are next to impossible to interpret.
In fact, attention is such a powerful tool that, in the final notebook, we will see how we can construct a language model _only using attention_.
