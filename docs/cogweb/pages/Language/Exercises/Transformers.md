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
import string

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

# Transformers


In 2017, Google Brain release a paper titled _Attention is All you Need_, where they departed from the traditional Seq2Seq architectures used in NLP and introduced a new kind of architecture: the transformer.
As the title of their paper suggests, the transformer is based on attention mechanisms, and does not use any kind of recurrent states as in RNNs.
This meant that a transformer could be trained significantly faster than a Seq2Seq model using RNNs, as sequences were no longer processed one token at a time, but rather all at once.
It also significantly reduced the complexity of the models being worked with.
As opposed to having complex Seq2Seq variations that can quickly become intractable, the transformer is composed of relatively straightforward matrix multiplications all the way through.

Since their introduction, transformers have been taking over the world of NLP.
GPT-3, a state-of-the-art language model capable of outputting text nearly impossible to distinguish from something human-written, is a massive transformer model.
Transformers have also seen applications in other fields of machine learning like computer vision, as their expresive power is, well, powerful.

In this notebook, we will take a deep dive into the original transformer architecture, writing up our own transformer and applying it to the translation problem of decoding a cipher.


## Making the Data (will be removed in final version, but for now included since the data isn't uploaded anywhere/might be changed slightly)

```python
from cogworks_data.language import get_data_path

path_to_wikipedia = get_data_path("wikipedia2text-extracted.txt")

with open(path_to_wikipedia, "rb") as f:
    wikipedia = f.read().decode()
    wikipedia = wikipedia.lower()
print(str(len(wikipedia)) + " character(s)")
```

```python
import re

# keep alpha + spaces
wikipedia = re.sub("[^ a-z]", "", wikipedia)
```

```python
from itertools import zip_longest

str_len = 25
# using all data is like 30 gigs in numpy array form
percent_of_data_to_use = 0.05

wiki_ls = [''.join(filter(None, s)) for s in zip_longest(*([iter(wikipedia)]*(str_len-1)))]
wiki_ls = wiki_ls[:-1] if len(wiki_ls[-1]) != str_len else wiki_ls

wiki_ls = wiki_ls[:int(len(wiki_ls) * percent_of_data_to_use)]
```

```python
ALPHA = "abcdefghijklmnopqrstuvwxyz "
IND_LOOKUP = {x:i for i, x in enumerate(ALPHA)}
LOOKUP_TABLE = np.array([x for x in ALPHA])
LOOKUP_TABLE = np.concatenate([np.roll(LOOKUP_TABLE, i)[None] for i in range(0, -len(ALPHA), -1)], axis=0)
```

```python
def cipher(plaintext, key):
    len_p = len(plaintext)
    len_k = len(key)

    key = (key * (len_p // len_k + 1))[:len_p]
    
    out = ""
    for p, k in zip(plaintext, key):
        ind_p = IND_LOOKUP[p]
        ind_k = IND_LOOKUP[k]

        out += LOOKUP_TABLE[ind_k, ind_p]
    
    return out
```

```python
key = "clap"

wiki_enc_ls = [cipher(x, key) for x in wiki_ls]
```

```python
def one_hot_encoding(text):
    """
    adds both a start and end token
    """
    seq_len = len(text)
    # +2 to seq_len to add in start/end tokens, +2 to dimension to account for new start/end tokens
    # start = [... 0 1 0], end = [... 0 0 1]
    out = np.zeros((seq_len+2, len(ALPHA)+2), dtype=np.float32)
    
    inds = [IND_LOOKUP[x] for x in text]
    out[range(1, seq_len+1), inds] = 1
    out[0, -2] = 1
    out[-1, -1] = 1
    
    return out
```

```python
# src one-hots dont need start token
wiki_src_dat = np.concatenate([one_hot_encoding(x)[1:, None] for x in wiki_enc_ls], axis=1)

# tgt one-hots dont need end token
wiki_tgt_dat = np.concatenate([one_hot_encoding(x)[:-1, None] for x in wiki_ls], axis=1)

print(wiki_src_dat.shape, wiki_tgt_dat.shape)
```

```python
# tgt inds do need end token (and no start)
wiki_tgt_inds = np.concatenate([np.array([IND_LOOKUP[x] for x in tgt_str] + [len(ALPHA) + 1]).reshape(-1, 1)
                                for tgt_str in wiki_ls], axis=1)

print(wiki_tgt_inds.shape)
```

```python
test_dat = ["cogworks has no asterisk",
            "blahblahblahblahblahblah"]

test_dat = [cipher(x, key) for x in test_dat]
test_dat = np.concatenate([one_hot_encoding(x)[1:, None] for x in test_dat], axis=1)

print(test_dat.shape)
```

```python
np.savez("./dat/wikipedia2text-encoded.npz",
         train_src_one_hot=wiki_src_dat,
         train_tgt_one_hot=wiki_tgt_dat,
         train_truth_inds=wiki_tgt_inds,
         test_src_one_hot=test_dat)
```

## Loading the Data


For this notebook, the data we will use is text encoded with a Vigenère cipher.
We will look at a set of encoded (source) and corresponding decoded (target) sequences to train our model on;
our goal will be to train a transformer to decode any new sequences that we get which have been encoded with the original cipher's key.
Tokens in these sequences are lowercase alphabetical characters, spaces, or start/end tokens.
All source sequences already have a start token prepended, and all target sequences have an end token appended.
The order of dimensions of the data is the same as in the Seq2Seq notebook.

Load in the training and testing data below, and print the shapes of each of the arrays.
What does each dimension in these arrays represent?

Note: moving forward, the sequence length $T$ or $t$ will encompass any start or end tokens in the data, respectively.
This is in contrast to the Seq2Seq notebook, where we referred to the sequence length as the sequence excluding start and end tokens.

```python
with np.load(get_data_path("wikipedia2text-encoded.npz")) as data:
    train_src_one_hot = data["train_src_one_hot"]
    train_tgt_one_hot = data["train_tgt_one_hot"]
    train_truth_inds = data["train_truth_inds"]
    test_src_one_hot = data["test_src_one_hot"]

# <COGINST>
# (T, N_train, C), (T, N_train, C), (T, N_train), (T, N_test, C)
print(train_src_one_hot.shape, train_tgt_one_hot.shape,
      train_truth_inds.shape, test_src_one_hot.shape)
# </COGINST>
```

## Multihead Attention

<!-- #region -->
In the previous notebook, we constructed an attention mechanism by using a few matrix multiplications to compute a "relevance score" between each of the encoder's hidden states and the decoder's current hidden state.
This simple mechanism proved very effective for the task of reversing digit sequences, as our model was able to completely master the problem when trained.

Here, we will be using a _scaled dot product attention_. As the name suggests, we will compute our attention scores by computing dot products.

This attention function takes in three inputs: the _queries_ $Q$, the _keys_ $K$, and the _values_ $V$.
The names are not completely arbitrary here: we can think of the keys and values as key-value pairs in a Python dictionary.

The queries and the keys are the two values compared to compute attention weights;
in particular, the attention weights measure how relevant the keys are to the queries.
The attention weights are then used in a weighted sum of the value vectors.
Thus how relevant a key is to the query determines how strongly weighted the corresponding value is in the final context vector.

For a given sequence, $Q$ will each be a $(t, d_k)$ matrix, $K$ will be a $(T, d_k)$ matrix, and $V$ will be a $(T, d_v)$ matrix;
in all three, each row corresponds to a token embedding in the sequence.
For instance, the queries will be represented by the matrix

\begin{align}
&\:\begin{matrix}\xleftarrow{\hspace{0.5em}} & d_k & \xrightarrow{\hspace{0.5em}}\end{matrix} \\
Q =\;\, &\begin{bmatrix}\leftarrow & \vec{q}_1 & \rightarrow \\ \leftarrow & \vec{q}_2 & \rightarrow \\ & \vdots & \\ \leftarrow & \vec{q}_t & \rightarrow\end{bmatrix}\;\;\begin{matrix}\Big\uparrow \\ t \\ \Big\downarrow\end{matrix}
\end{align}

While the sequence lengths $T$ and $t$ may be the same, it is also possible that they differ - hence the distinction.

As mentioned before, we will compute attention scores from $Q$ and $K$.
In particular, we will matrix multiply $Q$ and the transpose of $K$ to calculate the dot product between each query vector and each key vector

\begin{align}
&\begin{bmatrix}
    \;\;\; \uparrow \;\; & \quad \uparrow \; & & \;\, \uparrow \\ 
    \;\;\; \vec{k}_1 \;\; & \quad \vec{k}_2 \; & \;\; \cdots & \;\;\;\, \vec{k}_T \;\; \\ 
    \;\;\; \downarrow \;\; & \quad \downarrow \; & & \;\, \downarrow
\end{bmatrix} \\
E = QK^\intercal =
\begin{bmatrix}
    \leftarrow & \vec{q}_1 & \rightarrow \vphantom{\vec{q}_1\cdot\vec{k}_t} \\
    \leftarrow & \vec{q}_2 & \rightarrow \vphantom{\vec{q}_2\cdot\vec{k}_t} \\
    & \vdots & \\
    \leftarrow & \vec{q}_t & \rightarrow \vphantom{\vec{q}_T\cdot\vec{k}_t}
\end{bmatrix}
&\begin{bmatrix}
    \vec{q}_1\cdot\vec{k}_1 & \vec{q}_1\cdot\vec{k}_2 & \cdots & \vec{q}_1\cdot\vec{k}_T \\
    \vec{q}_2\cdot\vec{k}_1 & \vec{q}_2\cdot\vec{k}_2 & \cdots & \vec{q}_2\cdot\vec{k}_T \\
    \vdots & \vdots & \ddots & \vdots \\
    \vec{q}_t\cdot\vec{k}_1 & \vec{q}_t\cdot\vec{k}_2 & \cdots & \vec{q}_t\cdot\vec{k}_T \\
\end{bmatrix}=
\begin{bmatrix}
    e_{1,1} & e_{1,2} & \cdots & e_{1,T} \vphantom{\vec{q}_1\cdot\vec{k}_T} \\
    e_{2,1} & e_{2,2} & \cdots & e_{2,T} \vphantom{\vec{q}_2\cdot\vec{k}_T} \\
    \vdots & \vdots & \ddots & \vdots \\
    e_{t,1} & e_{t,2} & \cdots & e_{t,T} \vphantom{\vec{q}_T\cdot\vec{k}_T} \\
\end{bmatrix}
\end{align}


This gives us a $(t,T)$ matrix $E$, where the $(i,j)^\text{th}$ element in $e$ is the attention score between the $i^\text{th}$ query vector and the $j^\text{th}$ key vector.

Now, before we take the softmax of our attention scores to compute the attention weights, we will _scale_ each of the attention scores by a factor of $\frac{1}{\sqrt{d_k}}$.
This is done to push the dot products into a reasonable range for the subsequent softmax - too negative of a dot product will results in a near-zero gradient and thus the model will train less effectively.

\begin{equation}
E' = \frac{1}{\sqrt{d_k}}E
\end{equation}


We will now take the softmax of $E'$ to get our attention weights, where the sum in softmax is done over the columns of $E'$,

\begin{equation}
\alpha = \operatorname{softmax}(E') =
\begin{bmatrix}
    \operatorname{softmax}\begin{pmatrix}e'_{1,1} & e'_{1,2} & \cdots & e'_{1,T}\end{pmatrix} \\
    \operatorname{softmax}\begin{pmatrix}e'_{2,1} & e'_{2,2} & \cdots & e'_{2,T}\end{pmatrix} \\
    \vdots \\
    \operatorname{softmax}\begin{pmatrix}e'_{t,1} & e'_{t,2} & \cdots & e'_{t,T}\end{pmatrix}
\end{bmatrix}
\end{equation}


And, as we did before, we will use our attention weights as the coefficients in weighted sum of the value vectors - the rows of $V$ - and we can accomplish this with yet another matrix multiplication:

\begin{align}
&\begin{bmatrix}
    \xleftarrow{\hspace{6em}} & \vec{v}_1 & \xrightarrow{\hspace{6em}} \\
    \xleftarrow{\hspace{6em}} & \vec{v}_2 & \xrightarrow{\hspace{6em}} \\
    & \vdots &  \\
    \xleftarrow{\hspace{6em}} & \vec{v}_T & \xrightarrow{\hspace{6em}}
\end{bmatrix} \\
C = \alpha V =
\begin{bmatrix}
    \alpha_{1,1} & \alpha_{1,2} & \cdots & \alpha_{1,T} \vphantom{\sum\limits_{i=1}^T} \\
    \alpha_{2,1} & \alpha_{2,2} & \cdots & \alpha_{2,T} \vphantom{\sum\limits_{i=1}^T} \\
    \vdots & \vdots & \ddots & \vdots \\
    \alpha_{t,1} & \alpha_{t,2} & \cdots & \alpha_{t,T} \vphantom{\sum\limits_{i=1}^T} \\
\end{bmatrix}&
\begin{bmatrix}
    \sum\limits_{i=1}^T \alpha_{1,i}(\vec{v}_i)_1 & \sum\limits_{i=1}^T \alpha_{1,i}(\vec{v}_i)_2 & \cdots & \sum\limits_{i=1}^T \alpha_{1,i}(\vec{v}_i)_{d_v} \\
    \sum\limits_{i=1}^T \alpha_{2,i}(\vec{v}_i)_1 & \sum\limits_{i=1}^T \alpha_{2,i}(\vec{v}_i)_2 & \cdots & \sum\limits_{i=1}^T \alpha_{2,i}(\vec{v}_i)_{d_v} \\
    \vdots & \vdots & \ddots & \vdots \\
    \sum\limits_{i=1}^T \alpha_{t,i}(\vec{v}_i)_1 & \sum\limits_{i=1}^T \alpha_{t,i}(\vec{v}_i)_2 & \cdots & \sum\limits_{i=1}^T \alpha_{t,i}(\vec{v}_i)_{d_v}
\end{bmatrix} =
\begin{bmatrix}
    \leftarrow & \vec{c}_1 & \rightarrow \vphantom{\sum\limits_{i=1}^T} \\
    \leftarrow & \vec{c}_2 & \rightarrow \vphantom{\sum\limits_{i=1}^T} \\
    & \vdots &  \\
    \leftarrow & \vec{c}_t & \rightarrow \vphantom{\sum\limits_{i=1}^T}
\end{bmatrix}
\end{align}

This will give us a matrix $C$ that has shape-$(t, d_v)$, where each row is a context vector in the same sense as before.
Because of we weight the value vectors by attention weights from the keys, it often makes sense to have $K$ and $V$ be the same;
if we were to draw a parallel to our previous Seq2Seq model's attention mechanism, both $K$ and $V$ would have been $H^e$, while $Q$ would be $\vec{h}{}^d_t$.

All in all, we can write our attention as the function

\begin{equation}
C = \operatorname{Attention}(Q, K, V) = \operatorname{softmax}\bigg(\frac{QK^\intercal}{\sqrt{d_k}}\bigg)V.
\end{equation}
<!-- #endregion -->

One significant extension of the idea of attention introduced in the transformer architecture was that of **multihead attention**.
Put briefly, we will not just perform a single attention operation, but rather perform $h$ attention operations in parallel.
Each of these attention operations is known as an attention head.
By performing multiple attention operations at once, the model is able to learn a greater number of patterns in the data, having multiple opportunities to 'attend' to different parts of the inputs.

<!-- #region -->
To start this, we will define three sets of learnable weight matrices: $\big(W_q^{(i)}\big)_{i=1}^h$, $\big(W_k^{(i)}\big)_{i=1}^h$, and $\big(W_v^{(i)}\big)_{i=1}^h$.
Here, $h$ is the number of attention heads we choose to use.
Each of the weight matrices $W_q^{(i)}$, $W_k^{(i)}$, and $W_v^{(i)}$ will have shape $(d, d_k)$, $(d, d_k)$, and $(d, d_v)$, respectively.


As their names suggest, these weight matrices will be applied to $Q$, $K$, and $V$ to project the query, key, and value vectors into $d_k$ or $d_v$ dimensional space.
While we can pick the values of $d_k$ and $d_v$ to be anything, we will set them to

\begin{equation}
d_k=d_v=\bigg\lfloor\frac{d}{h}\bigg\rfloor.
\end{equation}

This is done so that the computational cost of using a large number of attention heads is roughly the same as using a small number of heads;
notice how these choices of $d_k$ and $d_v$ will have the total number of learnable parameters across a given set of $\big(W_\square^{(i)}\big)_{i=1}^h$ matrices remain around $d^2$.

Now, we will matrix multiply $Q$, $K$, and $V$ with the each of the corresponding weight matrices.
So for the $i^\text{th}$ attention head, we will have inputs

\begin{gather}
Q^{(i)}=QW_q^{(i)} \rightarrow (t,d)\times(d,d_k) \rightarrow (t,d_k) \\
K^{(i)}=KW_k^{(i)} \rightarrow (T,d)\times(d,d_k) \rightarrow (T,d_k) \\
V^{(i)}=VW_v^{(i)} \rightarrow (T,d)\times(d,d_v) \rightarrow (T,d_v)
\end{gather}

These learnable weight matrices are what will allow the model to detect different patterns in the data for each attention head, as they can learn different projections for the queries, keys, and values depending on the patterns they pick up on.
That being said each row of the new query, key, and value matrices still correspond to a different token from the sequence, and we can interpret them as the queries, keys, and values remapped to a semantically 'richer' embedding space.
<!-- #endregion -->

From here we can apply the scaled dot product attention to each of the $h$ triples $(Q^{(i)}, K^{(i)}, V^{(i)})$, yielding $h$ output matrices of shape $(t,d_v)$

\begin{equation}
C^{(i)}=\operatorname{Attention}(Q^{(i)},K^{(i)},V^{(i)}).
\end{equation}

However, since we only want a single matrix to be output from the attention mechanism, we will need to somehow combine the $h$ attention head outputs.
We can do this by concatenating the columns of each of the outputs

\begin{equation}
C =
\begin{bmatrix}
    \leftarrow & {\vec{c}_1}^{(1)} & \rightarrow & \leftarrow & {\vec{c}_1}^{(2)} & \rightarrow & \cdots & \leftarrow & {\vec{c}_1}^{(h)} & \rightarrow \\
    \leftarrow & {\vec{c}_2}^{(1)} & \rightarrow & \leftarrow & {\vec{c}_2}^{(2)} & \rightarrow & \cdots & \leftarrow & {\vec{c}_2}^{(h)} & \rightarrow \\
    & \vdots & & & \vdots & & \vdots & & \vdots & \\
    \leftarrow & {\vec{c}_t}^{(1)} & \rightarrow & \leftarrow & {\vec{c}_t}^{(2)} & \rightarrow & \cdots & \leftarrow & {\vec{c}_t}^{(h)} & \rightarrow \\
\end{bmatrix}
\end{equation}

This gives us the $\big(t,h\cdot\big\lfloor\frac{d}{h}\big\rfloor\big)$ matrix $C$, but we will ultimately want the output to be the same as if we had only one attention head.
That is, we want our final attention output to be shape $(T,d)$.
So what can we do?
Well, as is usually the answer, we will matrix multiply $C$ by a $\big(h\cdot\big\lfloor\frac{d}{h}\big\rfloor,d\big)$ matrix of learnable weights $W_O$:

\begin{equation}
C_\text{out} = CW_O
\end{equation}

The matrix $W_O$ will process the information in each from the attention heads and yield a matrix that summarizes all of the most important information picked up by the heads.
Our final output, $C_\text{out}$, will be a $(t, d)$ matrix - the same shape as the queries.


This has been a lot so far, and we're going to have to add a little more.
In our implementation, we will need to be careful to perform these operations in parallel not only over the attention heads, but also _over the batches of sequences_ that we will process.
So we should take a step back for a moment to look at how all these matrix multiplications will manifest in our code, as things can get unwieldy pretty quickly.

The inputs to our multihead attention will consist of a $N$-sized batch of length $t$/$T$ sequences, where each token in the sequence is a $d$ dimensional vector.
That is, $Q$, $K$, and $V$ will be tensors with shapes

```
Q : (t, N, d)
K : (T, N, d)
V : (T, N, d)
```

For our multihead attention, we will also need to define the sets of learnable weight matrices.
The individual weight matrices $W^{(i)}_q$, $W^{(i)}_k$, and $W^{(i)}_v$ will be shape $(d, d_k)$, $(d, d_k)$, and $(d, d_v)$, respectively.
For our implementation, we choose $d_k=d_v=\big\lfloor\frac{d}{h}\big\rfloor$.
Since we have $h$ of each of these weight matrices - one for each attention head - we can pack them into tensors with shapes

```
Wq : (h, d, d // h) = (h, d, k)
Wk : (h, d, d // h) = (h, d, k)
Wv : (h, d, d // h) = (h, d, v)
```

We also need to define the weight matrix $W_O$ that takes a matrix with the $h$ context vectors from each attention head concatenated together and maps it to a matrix of $d$-dimensional vectors.
That is, we need to define a weight matrix for $W_O$ with shape

```
Wo : (h * (d // h), d) = (h * v, d)
```


Now that we have all the variables we will need, we can think about how to perform the particular operations described in the math above.

In the multihead attention, the first step we need to take is to multiply $Q$, $K$, and $V$ by the respective weight matrices.
We must do this before computing any attention scores so that, as the model trains, if can tune the weights in such a way that the subsequent attention weights find more meaningful relations in the data.

To compute the matrix multiplications in parallel for each attention head, we will want to broadcast the matrix multiplication over the `h` dimension in the weight tensors.
Similarly, because we are computing these attention weights in parallel for each sequence in our batch, we will want to broadcast the operation over the `N` dimension of the queries/keys/values.
So, for each of the matrix multiplications, we will want to get outputs of shape

```
Q_i = Q x Wq : (t, N, d) x (h, d, k) -> (t, N, h, k)
K_i = K x Wk : (T, N, d) x (h, d, k) -> (T, N, h, k)
V_i = V x Wv : (T, N, d) x (h, d, v) -> (T, N, h, v)
```

Notice how the `d` dimension was 'contracted' over, such that it no longer appears in the output.
This indicates that a matrix multiplication was done with respect to the size `d` dimensions.

**Note:** for the next two operations detailed going forward, it is can be helpful to 'ignore' the `N` and `h` when thinking of how the matrix multiplications relate to the earlier formula.
Since the matrix multiplication will be broadcast over these batch and head dimensions, the matrix multiplications detailed earlier are actually happening between matrices with rows of the $0^\text{th}$ axis and columns of the $3^\text{rd}$ axis.

<!-- #region -->
From here, we go into computing attention weights for each attention head.
The first step to computing the attention weights is computing the dot product similarity between the queries and the keys, via a matrix multiplication.
As with the previous operations, this matrix multiplication will need to be broadcast over the batch and head dimensions in both `Q_i` and `K_i`.
This means we will compute attention scores with a shape of


```
E = Q_i x K_i : (t, N, h, k) x (T, N, h, k) -> (t, N, h, T)
```

As before, notice how the `k` dimension from both `Q_i` and `K_i` dissappeared in the output, indicating that dot products were computed between all of the `k`-dimensional vectors in the two tensors.

Now we divide `E` by $\sqrt{d_k}$ and take the softmax over the size `T` dimension to find the attention weights `α`.
These two operations will not change the shape of the tensor, and so `α` is a shape `(t, N, h, T)` tensor.

The attention weights are then matrix multiplied with `V_i` to compute a weighted sum of the values for each attention head.n
This means that we want to contract the `T` dimension in both `α` and `V_i`, giving an output `C` with shape

```
C_i = α x V_i : (t, N, h, T) x (T, N, h, v) -> (t, N, h, v)
```

At this point, we've finished computing context vectors for each of the attention heads;
`C_i` representes the `t` context vectors of dimensionality `v` for each of the `h` heads and each of the `N` sequences in our batch.
However for our final output, we want to 'summarize' the context vectors from each of the attention heads into a single context vector for each of the `t` tokens in the queries.
To do this mathematically, we concatenated the columns of each of the $C^{(i)}$ outputs for the attention heads and matrix multiplied the result with $W_O$.
In our Python code, to do this concatenation we can simply reshape the tensor `C_i` such that we combine the trailing two axes

```
C_i -> C :  (t, N, h, v) -> (t, N, h * v)
```

With the context vectors of each attention head concatenated, we can use `Wo` to project all of the `h * v` dimensional vectors into `d` dimensional vectors.
This giving us `C_out`, a tensor with shape

```
C_out = C x Wo : (t, N, h * v) x (h * v, d) -> (t, N, d)
```
<!-- #endregion -->

The comments in the `MultiheadAttention` class below provide instructions on how to implement the various matrix multiplications.
The MyGrad function `einsum` may be of use for performing many of the necessary steps.

```python
class MultiheadAttention:
    def __init__(self, dim, n_head=3):
        """ Initializes a multihead attention layer.
        
        Parameters
        ----------
        dim : int
            The dimension of the input sequences, `d`. For one-hot
            encodings, this is the size of the vocabulary.
        n_head : int
            The number of distinct attention heads to use.        
        """
        # Assign `self.Wq` to a tensor drawn from the glorot-normal distribution.
        # The tensor should be 3-dimensional, with shape (h, d, d // h)
        self.Wq = glorot_normal(n_head, dim, dim // n_head) # <COGLINE>
        
        # Assign `self.Wk` to a tensor drawn from the glorot-normal distribution.
        # The tensor should be 3-dimensional, with shape (h, d, d // h)
        self.Wk = glorot_normal(n_head, dim, dim // n_head) # <COGLINE>
        
        # Assign `self.Wv` to a tensor drawn from the glorot-normal distribution.
        # The tensor should be 3-dimensional, with shape (h, d, d // h)
        self.Wv = glorot_normal(n_head, dim, dim // n_head) # <COGLINE>
        
        # Assign `self.Wo` to a MyNN dense class that takes a
        # (t, N, h * [d // h]) array to a (t, N, d) array.
        # The dense layer should not have a bias term, and the
        # weights should be initialized from a glorot_normal distribution.
        # <COGINST>
        self.Wo = dense(n_head * (dim // n_head), dim, weight_initializer=glorot_normal, bias=False)
        # </COGINST>
    
    def __call__(self, Q, K, V, mask=None):
        """ Performs the full forward pass for the attention layer.
        
        Parameters
        ----------
        Q : Union[numpy.ndarray, mygrad.Tensor], shape=(t, N, d)
            The queries. These are the vectors that we want to
            improve by compute attention scores against.
        K : Union[numpy.ndarray, mygrad.Tensor], shape=(T, N, d)
            The keys. These are the vectors that have "information drawn
            from them" in computing attention scores. Each key token will
            be compared to each query token to find attention
            scores that determine the relevance of the key to the query.
        V : Union[numpy.ndarray, mygrad.Tensor], shape=(T, N, d)
            The values. These are the vectors that we want to
            weight according to the attention scores. Often times
            this is the same as x_k.
        mask : Optional[numpy.ndarray], dtype=bool, shape=(t, T)
            An optional mask to apply on attention weights.
            Values that are False are set to -1e14 before softmax
            is applied to the attention weights.
        
        Returns
        -------
        mygrad.Tensor
            A weighted sum of the values V. The weights are found by
            scoring the relevance of the keys to the queries.
        """
        # Compute Q_i, K_i, and V_i using `self.Wq`, `self.Wk`, and `self.Wv`.
        # Each of these should be 4-dimensional tensors,
        # with shape (t or T, N, h, d // h).
        #
        # These tensors contain the Q_i, K_i, and V_i for each sequence in the
        # batch and for each attention head we are computing.
        # <COGINST>
        Q_i = mg.einsum("tNd,hdk->tNhk", Q, self.Wq, optimize=True)
        K_i = mg.einsum("TNd,hdk->TNhk", K, self.Wk, optimize=True)
        V_i = mg.einsum("TNd,hdv->TNhv", V, self.Wv, optimize=True)
        # </COGINST>
        
        # Below, we will compute our scaled dot product attention with
        # the projected queries, keys, and values.
        #
        # Matrix multiply Q_i and the transpose of K_i
        # (only transposing the first and last axes),
        # and store the result in the variable `E`.
        # The matrix multiplication must be broadcast across
        # the batch and attention head dimensions.
        # The output should be shape (t, N, h, T).
        #
        # Then, divide `E` by sqrt(d_k),
        # storing the result in the variable `E` again.
        E = mg.einsum("tNhk,TNhk->tNhT", Q_i, K_i) / np.sqrt(self.Wk.shape[-1]) # <COGLINE>
        
        # We will see the use of this optional masking later.
        # The mask is a (t,T) array, and any index where the mask is
        # False will be zero-ed out in the attention weights.
        # The masking is broadcast over the batch and head dimensions.
        if mask is not None:
            E.transpose(1, 2, 0, 3)[:, :, ~mask.astype(np.bool_)] = -1e14
        
        # Apply softmax to to masked scores along the last axis,
        # and save the attention weights to `self.a_ij`
        self.a_ij = mg.nnet.softmax(E) # <COGLINE>
        
        # Matrix multiply the attention weights with V_i,
        # and transpose the output as neccessary such that is is
        # shape (T, N, h, d // h)
        C = mg.einsum("tNhT,TNhv->tNhv", self.a_ij, V_i) # <COGLINE>
        
        # We have now finished computing the each of the attention heads
        # and now need to combine all of them into a single matrix.
        #
        # Reshape the (t, N, h, d // h) tensor 
        # into a (t, N, h * [d // h]) tensor.
        # This is equivalent to concatenating the columns of the
        # individual attention head outputs.
        #
        # Then apply the final dense layer Wo to return
        # a shape (t, N, d) tensor
        # <COGINST>
        out = C.reshape(*C.shape[:2], -1)
        return self.Wo(out)
        # </COGINST>
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model. """
        return (self.Wq, self.Wk, self.Wv) + self.Wo.parameters # <COGLINE>
```

## Encoder


Much like our Seq2Seq model, a transformer has both an encoder and decoder.
The encoder is once again responsible for processing the source text, using **self-attention** to distill important relationships and patterns in the source text;
the encoder is responsible for finding out which tokens in the source text are most closely related to one another.
That is, we will use the batch of source sequences as all of the queries, keys, and values in a multihead attention.

Before we implement our encoder though, there is one small detour we need to make.


### Two Modern Deep Learning Techniques


We come now to two techniques that have risen rapidly in deep learning - residual connections and layer normalization.

Residual connections (also sometimes called skip connections) were introduced to enable 'deeper' models to be constructed.
They aim to help the gradient 'flow' more easily during backpropagation, by establishing a direct connection between the beginning and end of a layer in a model.
For any given layer, this is done by summing the input and output of the layer.
Thus during backpropagation, the gradient for the input of the layer will consist directly of both the incoming gradient to the layer, as well as the gradient from the layer itself.
This means that, if the gradient from the layer were to be very small, it would not as substantially impact the gradient of the input, which also sees directly the layer's incoming gradient.

Layer normalization is an idea similar to the more commonly seen batch normalization, though it sees much more use in NLP where batch normalization can be tricky with variable length sequences.
However, the core idea behind layer normalization is to reduce inter-layer variablility that can cause early layers to have outsized impacts on subsequent layers.
Such a dynamic can lead to exploding or vanishing gradients, neither of which is desirable when training a model.

Often times in deep learning research, residual connections and layer/batch normalization will be deployed as the general rule of thumb is that they help the training of a model by making the loss landscape easier to traverse.
The original transformer architecture employs these tricks, and so we will as well.

Below is a class `ResidualConnectionAndLayerNorm` that performs a residual connection followed by a layer normalization.
This class will be utilized after each layer in our transformer.
Calling it requires two arguments - `x_old` and `x_new` - which represent the input and output to the preceding transformer layer.
Briefly study the code below, to get a sense for what this class will do.

```python
class ResidualConnectionAndLayerNorm:
    def __init__(self, dim):
        """
        
        Parameters
        ----------
        dim : int
            This is d in the __call__ docstring
        """
        self.g = mg.ones(dim)
        self.b = mg.zeros(dim)
        
    def __call__(self, x_old, x_new):
        """
        
        Parameters
        ----------
        x_old : Union[numpy.ndarray, mygrad.Tensor], shape-(..., d)
        
        x_new : mygrad.Tensor, shape-(..., d)
        
        Returns
        -------
        mygrad.Tensor, shape-(..., d)
        """
        x = x_old + x_new
        
        # normalize over the trailing axis and apply
        # learnable scale and shift terms
        mu = x.mean(axis=-1, keepdims=True)
        sigma = x.std(axis=-1, keepdims=True)
        return self.g * (x - mu) / (sigma + 1e-6) + self.b
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model. """
        return (self.g, self.b)
```

Now, back to the interesting parts of the transformer's encoder.
Our transformer encoder will consist of two layers: a multihead self-attention layer, and a simple feedforward layer.
The feedforward layer will act as a sort of 'interpreter' for the context vectors yielded by the self-attention, distilling any meaningful information into a richer, abstract representation.
After both layers, we will apply a residual connection and layer normalization.
All in all, the transformer encoder will be structured as

\begin{align}
X_1 &= \operatorname{MultiHeadAttention}(\mathrm{src},\, \mathrm{src},\, \mathrm{src}) && \text{Self-attention layer} \\
X_2 &= \operatorname{LayerNorm}(\mathrm{src} + X_1) && \text{Residual connection and layer normalization} \\
X_3 &= \operatorname{ReLU}\!\big(X_2W_1 + \vec{b}_1\big)W_2 + \vec{b}_2 && \text{Feedforward layer} \\
\mathrm{Enc}_\text{out} &= \operatorname{LayerNorm}(X_2 + X_3) && \text{Residual connection and layer normalization}
\end{align}


Below are two classes, `FeedForward` and `TransformerEncoder`.
The `FeedForward` network will be a simple dense neural network using a ReLU activation function.
Complete the `FeedForward` class using MyNN's `dense`, then fill out the `TransformerEncoder` class according to the equations above.

```python
class FeedForward:
    def __init__(self, in_dim, h_dim, out_dim):
        """ Initializes a simple feedforward layer.
        
        Parameters
        ----------
        in_dim : int
            The dimensionality of the input vectors.
        
        h_dim : int
            The number of neurons in the hidden layer.
        
        out_dim : int
            The dimensionality of the output vectors.
        
        """
        # Initialize MyNN `dense` layers
        # <COGINST>
        self.W1 = dense(in_dim, h_dim, weight_initializer=glorot_normal)
        self.W2 = dense(h_dim, out_dim, weight_initializer=glorot_normal)
        # </COGINST>
    
    def __call__(self, x):
        """
        
        Parameters
        ----------
        x : Union[numpy.ndarray, mygrad.Tensor]
        
        Returns
        -------
        mygrad.Tensor
        
        """
        # Use a ReLU activation between the two dense layers
        # <COGINST>
        out = self.W1(x)
        out = mg.nnet.relu(out)
        return self.W2(out)
        # </COGINST>
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model. """
        return self.W1.parameters + self.W2.parameters # <COGLINE>
```

```python
class TransformerEncoder:
    def __init__(self, dim, h_dim, n_head=3):
        """ Initializes a TransformerEncoder object.
        
        Parameters
        ----------
        dim : int
            The dimensionality of both the input and output embeddings (`d`).
            These are the same to accomodate the residual connections.
        
        h_dim : int
            The number of neurons in the hidden layer of the feed forward
            layer.
        
        n_head : int
            The number of attention heads to apply on the self-attention layer.
        """
        # <COGINST>
        self.self_attn = MultiheadAttention(dim, n_head)
        self.ff = FeedForward(dim, h_dim, dim)
        self.norm1 = ResidualConnectionAndLayerNorm(dim)
        self.norm2 = ResidualConnectionAndLayerNorm(dim)
        # </COGINST>
    
    def __call__(self, src):
        """ Performs a full forward pass of the Transformer encoder.
        
        Parameters
        ----------
        src : Union[numpy.ndarray, mygrad.Tensor], shape=(T, N, d)
            The batch of source sequences
        
        Returns
        -------
        mygrad.Tensor, shape=(t, N, d)
        """
        # Apply the self-attention layer to the source sequence.
        # That is, use the source sequence as the queries, keys,
        # and targets for the attention layer.
        # This will have the model learn intra-sequence relations
        # for the source sequence.
        X1 = self.self_attn(src, src, src) # <COGLINE>
        
        # Apply the first residual + layernorm
        X2 = self.norm1(src, X1) # <COGLINE>
        
        # Apply the feedforward layer
        X3 = self.ff(X2) # <COGLINE>
        
        # Apply the second residual + layernorm
        return self.norm2(X2, X3) # <COGLINE>
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model. """
        # <COGINST>
        return self.self_attn.parameters + self.ff.parameters + self.norm1.parameters + self.norm2.parameters
        # </COGINST>
```

## Decoder





The transformer's decoder is a bit trickier than the encoder, because we are now going to also process the _target_ sequence.
This might seem strange;
wouldn't using the target sequence in training the model cause it to simply memorize the answers?
There is, after all, a reason that we previously haven't used the target value as part of the model's inputs.

Well for some NLP problems, it can make sense to use at least some of the target sequence as an input when training.
Since language is inherently sequential and past tokens will typically inform future tokens, then when predicting a target token it can be reasonable to give the model access to the prior predicted tokens.
We saw this idea in the Seq2Seq model, where the decoder output would determine the decoder's next input.
Since the transformer does not process data sequentially, and instead relies on attention layers to pick up on relationships between tokens, we will pass the full target sequence in and process it as needed.

In our transformer, the target sequence will be first passed through a self-attention layer.
Of course, we can't let the attention weights have access to the entirety of the target sequence - then it would just memorize the target by looking at the future tokens!
But for any given token, we _can_ compute attention weights for prior tokens from the target sequence.
By doing some clever masking of the target sequence, we can 'hide' the future tokens that the model shouldn't be seeing.
Let's take a look at a simplified example.

<!-- #region -->
Say that we have computed a self-attention weight of

```python
a_ij = np.array([[0.1, 0.7, 0.2],
                 [0.4, 0.2, 0.4],
                 [0.1, 0.8, 0.1]])
```

for our target sequence.
This would mean that, when looking at the first token in the target sequence, the model places a very high weight on the second token.

But when applying the transformer to new data, we won't necessarily have the target sequence available.
So we'll have to generate it one token at a time, meaning we don't know the second token until after we have processed the first token!
Thus when the model weights subsequent tokens in the target sequence, it is practically looking into the future to access information it shouldn't have.

To get around this, we can 'mask' our attention weights to only allow information to be used it it comes from either the current token or any previous token.
In other words, the attention weights for the first token can only be non-zero for the first token;
for the second token, the attention weights can be non-zero for either the first or second token.

We do this by setting the upper-right corner of the attention weights to a very large negative value (`-1e14`) before applying the softmax across the rows.
If the attention scores, before softmax was applied, of the earlier `a_ij` weights were

```python
C = np.array([[-2.30258509, -0.35667494, -1.60943791],
              [-0.91629073, -1.60943791, -0.91629073],
              [-2.30258509, -0.22314355, -2.30258509]])
```

then we would mask the scores as:

```python
C = np.array([[-2.30258509e+00, -1.00000000e+14, -1.00000000e+14],
              [-9.16290730e-01, -1.60943791e+00, -1.00000000e+14],
              [-2.30258509e+00, -2.23143550e-01, -2.30258509e+00]])
```

Since softmax exponentiates the values in the array, these very negative values will become `0`, while the other non-zero values will still sum to `1`.
Computing the masked self-attention weights would now yield:

```python
array([[1.        , 0.        , 0.        ],
       [0.66666667, 0.33333333, 0.        ],
       [0.1       , 0.8       , 0.1       ]])
```
<!-- #endregion -->

<!-- #region -->
This masking mechanism was pre-built into the `MultiheadAttention` class.
It will take in a boolean array, and will set any position where the mask is `False` to `-1e14`.
So for a mask and attention scores of

```python
# (3, 3)
mask = np.array([[ True, False,  True],
                 [False,  True, False],
                 [ True, False, False]])

# (1, 1, 3, 3)
C = np.array([[[[10,  2, -3],
                [ 5, -6,  4],
                [ 1, -5, 12]]]])
```

the masking would lead to a `C` of

```
array([[[[              10, -100000000000000,               -3],
         [-100000000000000,               -6, -100000000000000],
         [               1, -100000000000000, -100000000000000]]]])
```
<!-- #endregion -->

Aside from this masking, the decoder will largely resemble the encoder.
Of course, we will want to incorporate the output of the encoder as an input to the decoder.
So we will use _two_ attention layers here: one as a masked self-attention layer on the target sequence, and one as an attention layer between the encoder output and the target self-attention output.
The final tensor will be passed through a feedforward network, as in the encoder, as a means of 'interpreting' the results of the attention layers.
Put more succinctly, our decoder will take the form of

\begin{align}
X_1 &= \operatorname{MaskedMultiHeadAttention}(\mathrm{tgt},\, \mathrm{tgt},\, \mathrm{tgt}) && \text{Masked self-attention layer} \\
X_2 &= \operatorname{LayerNorm}(\mathrm{tgt} + X_1) && \text{Residual connection and layer normalization} \\
X_3 &= \operatorname{MultiHeadAttention}(X_2,\, \mathrm{Enc}_\text{out},\, \mathrm{Enc}_\text{out}) && \text{Encoder-decoder attention layer} \\
X_4 &= \operatorname{LayerNorm}(X_2 + X_3) && \text{Residual connection and layer normalization} \\
X_5 &= \operatorname{ReLU}\!\big(X_4W_1 + \vec{b}_1\big)W_2 + \vec{b}_2 && \text{Feedforward layer} \\
\mathrm{Dec}_\text{out} &= \operatorname{LayerNorm}(X_4 + X_5) && \text{Residual connection and layer normalization}
\end{align}

Complete the `TransformerDecoder` class below, following the outline above.
Make sure to only mask the self-attention layer for the target sequence, creating and passing in the appropriate mask array when the layer called.

```python
class TransformerDecoder:
    def __init__(self, dim, h_dim, n_head=3):
        """ Initializes a TransformerDecoder object.
        
        Parameters
        ----------
        dim : int
            The dimensionality of both the input and output embeddings (`d`).
            These are the same to accomodate the residual connections.
        
        h_dim : int
            The number of neurons in the hidden layer of the feed forward
            layer.
        
        n_head : int
            The number of attention heads to apply on both the
            self-attention layer and the encoder-decoder attention layer.
        """
        # Instantiate two attention layers:
        # one as a self-attention on the target sequence
        # and the other as an attention between the encoder output and the target sequence
        # <COGINST>
        self.self_attn = MultiheadAttention(dim, n_head)
        self.enc_dec_attn = MultiheadAttention(dim, n_head)
        # </COGINST>
        
        # Instantiate a feedforward layer and 3 residual+layernorms
        # <COGINST>
        self.ff = FeedForward(dim, h_dim, dim)
        self.norm1 = ResidualConnectionAndLayerNorm(dim)
        self.norm2 = ResidualConnectionAndLayerNorm(dim)
        self.norm3 = ResidualConnectionAndLayerNorm(dim)
        # </COGINST>
    
    def __call__(self, enc_out, tgt):
        """
        
        Parameters
        ----------
        enc_out : mygrad.Tensor, shape=(T, N, d)
            The output of the transformer's encoder.
        
        tgt : Union[numpy.array, mygrad.Tensor], shape=(t, N, d)
            The batch target sequence for translation
        
        Returns
        -------
        mygrad.Tensor, shape=(T, N, d)
        """
        # Create a mask for the target sequence self-attention layer
        # that will result in the upper right corner of the attention
        # scores being set to -1e14.
        # The mask should be a (t, t) boolean NumPy array.
        # <COGINST>
        t = tgt.shape[0]
        mask = np.tril(np.ones((t, t))).astype(np.bool_)
        # </COGINST>
        
        # apply the masked self-attention layer to the target sequence
        X1 = self.self_attn(tgt, tgt, tgt, mask=mask) # <COGLINE>
        
        # apply the first layernorm
        X2 = self.norm1(tgt, X1) # <COGLINE>
        
        # apply the encoder-decoder attention layer
        # the 'queries' should be the output of the target self-attention
        # and the 'keys' and 'values' should be the output of the encoder
        X3 = self.enc_dec_attn(X2, enc_out, enc_out) # <COGLINE>
        
        # apply the second layernorm
        X4 = self.norm2(X2, X3) # <COGLINE>
        
        # apply the feedforward network
        X5 = self.ff(X4) # <COGLINE>
        
        # apply the final layernorm
        return self.norm3(X4, X5) # <COGLINE>
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model. """
        # <COGINST>
        return (self.self_attn.parameters + self.enc_dec_attn.parameters + self.ff.parameters
                + self.norm1.parameters + self.norm2.parameters + self.norm3.parameters)
        # </COGINST>
```

## Positional Encoding





We're almost ready to put together our transformer, but there's one last, very crucial, piece we're still missing.
When we were working with RNNs, the architecture of the model itself - the fact that the RNN processed tokens sequentially - allowed the model to leverage positional information about the sequence.
But so far, our transformer has no such way to learn positional information from the inputs;
the transformer in its current state would be like a bag-of-words, losing all information about the locations of tokens in a sequence.

To get around this, we will put our source and target sequences through a **positional encoding**.
The positional encoding will yield a unique vector for each token in the sequence that corresponds only to its position in the sequence, and the dimensionality of the token's vector representation.
Since the positional encoding only depends on the shapes of the input sequences, it can be thought of as a constant 'fingerprint' that we will add onto the sequences before passing them through the encoder and decoder;
this allows us to provide positional information about tokens in the sequence to the model.


A class `PositonalEncoder` is included below.
There are two variables required: `dim_input` and `seq_len`.
`dim_input` corresponds to the dimension of the token embeddings, while `seq_len` is, well, the length of the sequence.
The output is a shape `(seq_len, 1, dim_input)` array, where the singleton dimension is included so that the output is broadcast compatable with batches of sequences.

Run the following cells to visualize the output of the positional encoder.
Along the `dim_input` dimension are sinusoids of decreasing frequencies;
notice how this makes it such that the `seq_len` dimension has a unique vector corresponding to each token.

```python
class PositionalEncoder:
    def __init__(self, dim):
        """ Initializes a positional encoder for a transformer model.
        
        Parameters
        ----------
        dim : int
            The dimensionality `d` of the embeddings of tokens in the
            source and target sequences. For one-hot encodings, this
            is just the size of the vocabulary.
        """
        self.dim = dim
        
    def __call__(self, seq_len):
        """ Computes a positional encoding 'fingerprint' for each token in a sequence.
        
        Parameters
        ----------
        seq_len : int
            The length of the sequence being encoded (`T`).
        
        Returns
        -------
        numpy.ndarray, shape: (T, 1, d)
            Positional encodings for a sequence of length T with embeddings of
            size d, made to be broadcastable with a batch of sequences.
        """
        den = 10000 ** (-np.arange(0, self.dim, 2) / self.dim)
        pos = np.arange(0, seq_len).reshape(seq_len, 1)
        
        out = np.zeros((seq_len, self.dim))
        out[:, 0::2] = np.sin(pos * den)
        out[:, 1::2] = np.cos(pos * den[:self.dim // 2])
        
        return out[:, None]
```

```python
C = 50 # token embedding size 
T = 20 # sequence length

pos = PositionalEncoder(C)

fig, ax = plt.subplots()

# squeeze here to remove the batch dimension for plotting
ax.imshow(pos(T).squeeze())

ax.set_xlabel("Dimension of Token Embeddings")
ax.set_ylabel("Positional Encoding for\nTokens in Sequence");
```

Applying this positional encoding to the source and target sequences will simply be summing the sequence and the positional encoding.
Since the output of the positional encoding has a shape of `(T, 1, C)`, the addition will be broadcast over the batch and every sequence in the batch will have the same positional encoding applied to it.
This invariance in the positional encoding across sequences is what allows the model to learn it these encodings represent locations of tokens in the sequence.


## Transformer


Now that we have all the necessary pieces, its finally time to roll out our full transformer model.
Complete the `Transformer` class below, carefully reading the docstrings and following the instructions in the comments.

```python
class Transformer:
    def __init__(self, dim, h_dim, n_enc, n_dec, n_head=3):
        """ Instantiates a full transformer model.
        
        Parameters
        ----------
        dim : int
            The dimensionality of tokens in the source and target sequences (`d`).
        
        h_dim : int
            The number of neurons in each feed forward layer.
        
        n_enc : int
            The number of encoder layers to apply sequentially.
        
        n_dec : int
            The number of decoder layers to apply sequentially.
        
        n_head : int
            The number of attention heads to use in each multi-head attention.
        
        """
        # Instantiate a `PositionalEncoder` with
        # the appropriate embedding dimension
        self.pos_enc = PositionalEncoder(dim) # <COGLINE>
        
        # Create two lists, one of `TransformerEncoder`s and one of `TransformerDecoder`s,
        # of lengths `n_enc` and `n_dec`. We will iterate over these lists to apply
        # multiple encoder or decoder layers in `__call__`.
        # <COGINST>
        self.enc_layers = [TransformerEncoder(dim, h_dim, n_head) for _ in range(n_enc)]
        self.dec_layers = [TransformerDecoder(dim, h_dim, n_head) for _ in range(n_dec)]
        # </COGINST>
        
        # Instantiate a MyNN `dense` layer that will 'interpret' the
        # final decoder output before the softmax probabilities are
        # computed for each token.
        #
        # The dense layer should take `d` dimensional vectors to
        # `d` dimensional vectors.
        # Use glorot_normal as the weight initializer.
        self.out_dense = dense(dim, dim, weight_initializer=glorot_normal) # <COGLINE>
    
    def __call__(self, src, tgt):
        """ Performs a full transformer forward pass.
        
        Parameters
        ----------
        src : Union[numpy.ndarray, mygrad.Tensor], shape=(T, N, d)
            The batch of source sequences.
        
        tgt : Union[numpy.ndarray, mygrad.Tensor], shape=(t, N, d)
            The batch of target sequences.
        
        Returns
        -------
        mygrad.Tensor, shape=(t, N, d)
        """
        # Compute the positional encoding for the source sequence.
        # and sum it with the source sequence.
        x = src + self.pos_enc(src.shape[0]) # <COGLINE>
        
        # Iterate over the list of encoder layers.
        # Use the output of each as the input to the next layer.
        # Make sure to save the final encoder layers' output
        # for use in the decoder.
        # <COGINST>
        for enc in self.enc_layers:
            x = enc(x)
        enc_out = x
        # </COGINST>
        
        # Compute the positional encoding for the target sequence.
        # and sum it with the target sequence.
        x = tgt + self.pos_enc(tgt.shape[0]) # <COGLINE>
        
        # Iterate over the list of decoder layers.
        # Use the output of each as the input to the next layer.
        # <COGINST>
        for dec in self.dec_layers:
            x = dec(enc_out, x)
        # </COGINST>
        
        # Apply the final dense layer and return the output
        return self.out_dense(x) # <COGLINE>
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model. """
        # <COGINST>
        params = sum((enc.parameters for enc in self.enc_layers), ())
        params += sum((dec.parameters for dec in self.dec_layers), ())
        
        return params + self.out_dense.parameters
        # </COGINST>
```

## Training


Instatiate a nogging plot to track the loss and accuracy of the transformer as it trains.

```python
from noggin import create_plot
plotter, fig, ax = create_plot(["loss", "accuracy"]) # <COGLINE>
```

Instatiate the `Transformer` and an `Adam` optimizer.

Using the default parameters for the optimizer is good.
Starting with a feedforward hidden dimension of `30`, `2` encoder layers, `2` decoder layers, and `4` attention heads is a reasonable starting place for the model;
after completing the notebook, try adjusting these values and seeing how it impacts the performance and the learned attention weights.

```python
# <COGINST>
d = train_src_one_hot.shape[-1]

model = Transformer(d, 30, 2, 2, n_head=4)
optimizer = Adam(model.parameters)
# </COGINST>
```

Write your training loop below.
Remember, the $0^\text{th}$ dimension of the data corresponds to the sequence length, while the $1^\text{st}$ dimension corresponds to the batch of sequences.

Use a `softmax_crossentropy` loss, and remember the necessary input shapes for the function.

Start by training the model for a single epoch, with a batch size of $10$;
feel free to revist these values as well.

```python
# <COGINST>
mg.turn_memory_guarding_off()

batch_size = 10
num_epochs = 1
dataset_size = train_src_one_hot.shape[1]

for epoch_cnt in range(num_epochs):
    idxs = np.arange(dataset_size)
    np.random.shuffle(idxs)

    for batch_cnt in range(0, dataset_size // batch_size):
        # adjusting the lr seems to help speed up
        # convergence a bit but it isn't really necessary
        if batch_cnt == 7500:
            optimizer = Adam(model.parameters, learning_rate=1e-5)
        
        batch_indices = idxs[batch_cnt * batch_size : (batch_cnt + 1) * batch_size]

        # since the data are shape (T, N, ...), we need to
        # index into the 1st dimension with `batch_indices`
        src_batch = train_src_one_hot[:, batch_indices]
        tgt_batch = train_tgt_one_hot[:, batch_indices]
        truth_batch = train_truth_inds[:, batch_indices]

        pred = model(src_batch, tgt_batch)

        loss = softmax_crossentropy(pred.reshape(-1, pred.shape[-1]), truth_batch.reshape(-1))
        loss.backward()
        optimizer.step()

        acc = np.mean(np.all(np.argmax(pred, axis=-1) == truth_batch, axis=0))

        plotter.set_train_batch({"loss":loss.item(), "accuracy":acc}, batch_size=batch_size)

        if batch_cnt % 1000 == 0 and batch_cnt > 0:
            plotter.set_train_epoch()
# </COGINST>
```

## Cracking the Code


Now that we have trained our transformer up to a pretty good accuracy, what do we do when we get a new encypted text?
Well, we can use our model to decode it!

Of course, unlike during training, we no longer have access to the full target text to pass in as an input.
So we will have to iteratively generate the target sequence, in much the same way as our previous Seq2Seq model did.

Complete the cell below that will perform greedy decoding.
As in the Seq2Seq model, we will generate the target sequence one token at a time, 'greedily' picking the class with the largest predicted score to be the next token in the sequence.

```python
# perform greedy decoding for inference
test_tgt_one_hot = np.zeros_like(test_src_one_hot)
test_tgt_one_hot[0, :, -2] = 1 # start all sequence with a start token

for i in range(len(test_tgt_one_hot)-1):
    # access first `i` tokens in tgt sequence
    tgt = test_tgt_one_hot[:i+1] # <COGLINE>
    
    # pass in full src sequence and partial tgt sequence
    pred = model(test_src_one_hot, tgt) # <COGLINE>
    
    # update `i+1`th token based on largest predicted score for last token
    # <COGINST>
    ind = pred[-1].argmax(axis=-1)
    test_tgt_one_hot[i+1, range(len(ind)), ind] = 1
    # </COGINST>
```
Now, let's convert the predicted one-hot encodings into text that we can read.

```python
# define our alphabet, with: ` ` = space, ~ = start, ! = stop
ALPHA_STA_STO = string.ascii_lowercase + " ~!"

decoded_str = []

# iterate over batch dimension
for seq_one_hot in test_tgt_one_hot.transpose(1, 0, 2):
    # index into alphabet based on one-hot encodings for sequence
    seq_text = "".join([ALPHA_STA_STO[i] for i in seq_one_hot.argmax(axis=-1)])
    decoded_str.append(seq_text)

decoded_str
```

Awesome, we can now decode any new encoded messages that we get (to a reasonable accuracy)!

Finally, let's visualize all our attention heads.
Fill in the following cell with the names attributes in your transformer, then run the subsequent cells to plot the attention heads.
The code will plot the attention heads for the $0^\text{th}$ sequence in the last batch processed by the model.

```python
# set model to the trained `Transformer` model
model = model

# set to the name of the list of `TransformerEncoder`s in the `Transformer` (as a string)
enc_layers = "enc_layers"

# set to the name of the list of `TransformerDecoder`s in the `Transformer` (as a string)
dec_layers = "dec_layers"

# set to the name of the self-attention `MultiHeadAttention` in the `TransformerEncoder` (as a string)
enc_self_attn = "self_attn"

# set to the name of the self-attention `MultiHeadAttention` in the `TransformerDecoder` (as a string)
dec_self_attn = "self_attn"

# set to the name of the encoder-decoder `MultiHeadAttention` in the `TransformerDecoder` (as a string)
dec_enc_dec_attn = "enc_dec_attn"
```

```python
enc_layers_ls = getattr(model, enc_layers)

n_layers = len(enc_layers_ls)
n_heads = len(getattr(enc_layers_ls[0], enc_self_attn).Wq)

fig, ax = plt.subplots(n_layers, n_heads)
ax = np.array(ax).reshape(n_layers, n_heads)

for i, layer in enumerate(enc_layers_ls):
    a_ij = getattr(layer, enc_self_attn).a_ij[:, 0] # shape: (T, h, t)
    for j in range(a_ij.shape[1]):
        head_aij = a_ij[:, j]
        ax[i, j].imshow(head_aij);
```

```python
dec_layers_ls = getattr(model, dec_layers)

n_layers = len(dec_layers_ls)
n_heads = len(getattr(dec_layers_ls[0], dec_self_attn).Wq)

fig, ax = plt.subplots(n_layers, n_heads)
ax = np.array(ax).reshape(n_layers, n_heads)

for i, layer in enumerate(dec_layers_ls):
    a_ij = getattr(layer, dec_self_attn).a_ij[:, 0] # shape: (T, h, t)
    for j in range(a_ij.shape[1]):
        head_aij = a_ij[:, j]
        ax[i, j].imshow(head_aij);
```

```python
n_layers = len(dec_layers_ls)
n_heads = len(getattr(dec_layers_ls[0], dec_enc_dec_attn).Wq)

fig, ax = plt.subplots(n_layers, n_heads)
ax = np.array(ax).reshape(n_layers, n_heads)

for i, layer in enumerate(dec_layers_ls):
    a_ij = getattr(layer, dec_enc_dec_attn).a_ij[:, 0] # shape: (T, h, t)
    for j in range(a_ij.shape[1]):
        head_aij = a_ij[:, j]
        ax[i, j].imshow(head_aij);
```
